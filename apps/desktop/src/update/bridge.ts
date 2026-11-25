import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  type UpdateBridgeDescriptor,
  type UpdateBridgeServerFrame,
  updateBridgeClientFrame,
  updateBridgeDescriptor,
  updateBridgeServerFrame,
  updateBridgeStatus,
} from "@cashu/host-protocol/update-bridge";
import { ensurePrivateDir, hostRunPaths } from "@cashu/node-host";
import type { UpdateController } from "./controller.js";

const MAX_FRAME = 16_384;
const DESCRIPTOR = "update-main-capability.json";

function privateDir(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("update_bridge_dir_not_private");
}

function writeFrame(
  socket: Socket,
  frame: UpdateBridgeServerFrame,
  callback?: () => void,
): boolean {
  try {
    const data = `${JSON.stringify(updateBridgeServerFrame.parse(frame))}\n`;
    if (
      Buffer.byteLength(data) > MAX_FRAME ||
      socket.destroyed ||
      socket.writableLength > MAX_FRAME
    ) {
      socket.destroy();
      return false;
    }
    socket.write(data, callback);
    return true;
  } catch {
    socket.destroy();
    return false;
  }
}

/** Owns the update capability while this exact Electron main process is alive. */
export async function startMainUpdateBridge(
  controller: UpdateController,
  dataDir: string,
  build: string,
  bundleIdentity: string,
): Promise<{ readonly descriptor: UpdateBridgeDescriptor; close(): Promise<void> }> {
  privateDir(dataDir);
  const paths = hostRunPaths(dataDir);
  ensurePrivateDir(paths.socketDir);
  const descriptorPath = join(dataDir, DESCRIPTOR);
  const session = randomUUID();
  const token = randomBytes(32).toString("hex");
  const socketPath = join(paths.socketDir, `u-${randomBytes(6).toString("hex")}.sock`);
  if (Buffer.byteLength(socketPath) > 100) throw new Error("update_bridge_socket_path_too_long");
  const descriptor = updateBridgeDescriptor.parse({
    schema: 1,
    socket: socketPath,
    token,
    session,
    build,
    bundle: bundleIdentity,
    pid: process.pid,
  });
  const sockets = new Set<Socket>();
  const authenticatedSockets = new Set<Socket>();
  let ownedSocket: { dev: number; ino: number } | undefined;
  const temp = `${descriptorPath}.${session}.tmp`;
  let tempOwned = false;
  let closed = false;
  let installScheduled = false;
  let closeBridge: (() => Promise<void>) | undefined;
  const status = () => updateBridgeStatus.parse(controller.status());
  let descriptorStat: { dev: number; ino: number } | undefined;
  const sessionCurrent = () => {
    if (closed || !descriptorStat) return false;
    try {
      const fd = openSync(descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        return (
          stat.isFile() &&
          stat.size <= 6144 &&
          (stat.mode & 0o077) === 0 &&
          (process.getuid === undefined || stat.uid === process.getuid()) &&
          stat.dev === descriptorStat.dev &&
          stat.ino === descriptorStat.ino &&
          updateBridgeDescriptor.parse(JSON.parse(readFileSync(fd, "utf8"))).session === session
        );
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  };
  const server = createServer((socket) => {
    if (sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let authenticated = false;
    let buffer = "";
    let pending = false;
    const timeout = setTimeout(() => socket.destroy(), 5000);
    socket.on("close", () => {
      sockets.delete(socket);
      authenticatedSockets.delete(socket);
      clearTimeout(timeout);
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_FRAME) {
        socket.destroy();
        return;
      }
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let frame: ReturnType<typeof updateBridgeClientFrame.parse>;
        try {
          frame = updateBridgeClientFrame.parse(JSON.parse(line));
        } catch {
          socket.destroy();
          return;
        }
        if (!authenticated) {
          if (
            frame.t !== "hello" ||
            frame.token !== token ||
            frame.session !== session ||
            frame.build !== build ||
            frame.bundle !== bundleIdentity
          ) {
            socket.destroy();
            return;
          }
          authenticated = true;
          authenticatedSockets.add(socket);
          clearTimeout(timeout);
          writeFrame(socket, {
            t: "ready",
            session,
            build,
            bundle: bundleIdentity,
            status: status(),
          });
          continue;
        }
        if (frame.t !== "action" || pending) {
          socket.destroy();
          return;
        }
        if (!sessionCurrent()) {
          socket.destroy();
          return;
        }
        pending = true;
        if (frame.action === "install") {
          const state = controller.status();
          if (
            state.availability !== "ready" ||
            state.latest === null ||
            state.app?.stage !== "available"
          ) {
            writeFrame(socket, {
              t: "result",
              id: frame.id,
              outcome: { kind: "refused", reason: "update_not_ready" },
            });
          } else if (installScheduled) {
            writeFrame(socket, {
              t: "result",
              id: frame.id,
              outcome: { kind: "refused", reason: "install_already_scheduled" },
            });
          } else {
            installScheduled = true;
            let started = false;
            let ackFlushed = false;
            let closedBeforeAck = false;
            const startAcceptedInstall = (...callbackArgs: unknown[]) => {
              if (callbackArgs[0] instanceof Error || closedBeforeAck) {
                installScheduled = false;
                return;
              }
              ackFlushed = true;
              if (started) return;
              started = true;
              setImmediate(() => {
                if (!sessionCurrent()) {
                  installScheduled = false;
                  return;
                }
                void controller
                  .act("install")
                  .catch(() => undefined)
                  .finally(() => {
                    if (controller.canRetryInstallAfterAttempt()) installScheduled = false;
                  });
              });
            };
            const accepted = writeFrame(
              socket,
              {
                t: "result",
                id: frame.id,
                outcome: { kind: "outcome_unknown", reason: "install_scheduled" },
              },
              startAcceptedInstall,
            );
            if (accepted)
              socket.once("close", () => {
                if (!ackFlushed) {
                  closedBeforeAck = true;
                  installScheduled = false;
                }
              });
            else installScheduled = false;
          }
          pending = false;
          continue;
        }
        void controller
          .act(frame.action, frame.enabled)
          .then((outcome) => {
            if (!closed && !socket.destroyed)
              writeFrame(socket, { t: "result", id: frame.id, outcome });
          })
          .catch(() => {
            if (!closed && !socket.destroyed)
              writeFrame(socket, {
                t: "result",
                id: frame.id,
                outcome: { kind: "outcome_unknown", reason: "unexpected_failure" },
              });
          })
          .finally(() => {
            pending = false;
          });
      }
    });
  });
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
    if (closeBridge) void closeBridge().catch(() => undefined);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const socketStat = lstatSync(socketPath);
    if (!socketStat.isSocket() || (process.getuid && socketStat.uid !== process.getuid()))
      throw new Error("update_bridge_socket_invalid");
    ownedSocket = { dev: socketStat.dev, ino: socketStat.ino };
    const { chmodSync } = await import("node:fs");
    chmodSync(socketPath, 0o600);
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    tempOwned = true;
    try {
      writeFileSync(fd, JSON.stringify(descriptor));
      const { fsyncSync } = await import("node:fs");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, descriptorPath);
    tempOwned = false;
  } catch (error) {
    try {
      server.close();
    } catch {
      /* listen failed before binding */
    }
    if (tempOwned)
      try {
        unlinkSync(temp);
      } catch {
        /* absent */
      }
    try {
      const stat = lstatSync(socketPath);
      if (ownedSocket && stat.dev === ownedSocket.dev && stat.ino === ownedSocket.ino)
        unlinkSync(socketPath);
    } catch {
      /* absent or replaced */
    }
    throw error;
  }
  descriptorStat = statSync(descriptorPath);
  let watch: NodeJS.Timeout | undefined;
  const unsubscribe = controller.onChange(() => {
    for (const socket of authenticatedSockets)
      if (!socket.destroyed) {
        try {
          writeFrame(socket, { t: "status", status: status() });
        } catch {
          socket.destroy();
        }
      }
  });
  const bridge = {
    descriptor,
    async close() {
      if (closed) return;
      closed = true;
      if (watch) clearInterval(watch);
      controller.dispose();
      unsubscribe();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const fd = openSync(descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (
            stat.isFile() &&
            stat.size <= 6144 &&
            (stat.mode & 0o077) === 0 &&
            (process.getuid === undefined || stat.uid === process.getuid()) &&
            descriptorStat &&
            stat.ino === descriptorStat.ino &&
            stat.dev === descriptorStat.dev &&
            updateBridgeDescriptor.parse(JSON.parse(readFileSync(fd, "utf8"))).session === session
          )
            unlinkSync(descriptorPath);
        } finally {
          closeSync(fd);
        }
      } catch {
        /* another session replaced the descriptor */
      }
      try {
        const stat = lstatSync(socketPath);
        if (ownedSocket && stat.dev === ownedSocket.dev && stat.ino === ownedSocket.ino)
          unlinkSync(socketPath);
      } catch {
        /* already removed or replaced */
      }
    },
  };
  closeBridge = bridge.close;
  watch = setInterval(() => {
    if (!sessionCurrent()) void bridge.close().catch(() => undefined);
  }, 1000);
  watch.unref();
  return bridge;
}
