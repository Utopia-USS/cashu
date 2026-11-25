import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type UpdateBridgeDescriptor,
  type UpdateBridgeServerFrame,
  updateBridgeDescriptor,
  updateBridgeServerFrame,
} from "@cashu/host-protocol/update-bridge";
import { hostRunPaths } from "@cashu/node-host";
import type { UpdateStatus } from "@cashu/store/device";
import type { UpdateProvider } from "./updateScreen.js";

const MAX_FRAME = 16_384;
const MAX_DESCRIPTOR = 6144;
type FoundDescriptor = UpdateBridgeDescriptor & { readonly identity: string };

function readDescriptor(
  dataDir: string,
  build: string,
  bundle: string,
): FoundDescriptor | undefined {
  try {
    const dir = lstatSync(dataDir);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      (process.getuid && dir.uid !== process.getuid()) ||
      (dir.mode & 0o077) !== 0
    )
      return undefined;
    const path = join(dataDir, "update-main-capability.json");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let descriptor: UpdateBridgeDescriptor;
    let identity: string;
    try {
      const file = fstatSync(fd);
      if (
        !file.isFile() ||
        file.size > MAX_DESCRIPTOR ||
        (process.getuid && file.uid !== process.getuid()) ||
        (file.mode & 0o077) !== 0
      )
        return undefined;
      descriptor = updateBridgeDescriptor.parse(JSON.parse(readFileSync(fd, "utf8")));
      identity = `${file.dev}:${file.ino}`;
    } finally {
      closeSync(fd);
    }
    if (
      descriptor.build !== build ||
      descriptor.bundle !== bundle ||
      descriptor.pid === process.pid
    )
      return undefined;
    if (!isAbsolute(descriptor.socket)) return undefined;
    const socketDir = hostRunPaths(dataDir).socketDir;
    const parent = lstatSync(socketDir);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (process.getuid && parent.uid !== process.getuid()) ||
      (parent.mode & 0o077) !== 0
    )
      return undefined;
    const rel = relative(socketDir, descriptor.socket);
    if (
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      !/^u-[a-f0-9]{12}\.sock$/.test(rel)
    )
      return undefined;
    const socket = lstatSync(descriptor.socket);
    if (
      !socket.isSocket() ||
      (process.getuid && socket.uid !== process.getuid()) ||
      (socket.mode & 0o077) !== 0
    )
      return undefined;
    return { ...descriptor, identity };
  } catch {
    return undefined;
  }
}

export interface HostUpdateBridge extends UpdateProvider {
  close(): void;
}

/** Connects an exact-build host to one live main-process capability; unavailable on disconnect. */
export function hostUpdateBridge(dataDir: string, build: string, bundle: string): HostUpdateBridge {
  let descriptor: FoundDescriptor | undefined;
  let socket: Socket | undefined;
  let current = false;
  let closed = false;
  let status: UpdateStatus = { availability: "unavailable" };
  let nextId = 1;
  const listeners = new Set<() => void>();
  const pending = new Map<
    number,
    { resolve(value: Awaited<ReturnType<UpdateProvider["act"]>>): void; timer: NodeJS.Timeout }
  >();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const invalidate = () => {
    current = false;
    status = { availability: "unavailable" };
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.resolve({ kind: "outcome_unknown", reason: "bridge_disconnected" });
    }
    pending.clear();
    socket?.destroy();
    socket = undefined;
    descriptor = undefined;
    emit();
  };
  const connectOnce = () => {
    if (closed || socket) return;
    const found = readDescriptor(dataDir, build, bundle);
    if (!found) return;
    descriptor = found;
    const candidate = connect(found.socket);
    socket = candidate;
    let buffer = "";
    const helloTimer = setTimeout(() => candidate.destroy(), 5000);
    candidate.on("connect", () => {
      candidate.write(
        `${JSON.stringify({ t: "hello", token: found.token, session: found.session, build, bundle })}\n`,
      );
    });
    candidate.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_FRAME) {
        candidate.destroy();
        return;
      }
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let frame: UpdateBridgeServerFrame;
        try {
          frame = updateBridgeServerFrame.parse(JSON.parse(line));
        } catch {
          candidate.destroy();
          return;
        }
        if (frame.t === "ready") {
          if (
            current ||
            frame.session !== found.session ||
            frame.build !== build ||
            frame.bundle !== bundle
          ) {
            candidate.destroy();
            return;
          }
          clearTimeout(helloTimer);
          current = true;
          status = frame.status;
          emit();
        } else if (!current) {
          candidate.destroy();
          return;
        } else if (frame.t === "status") {
          status = frame.status;
          emit();
        } else {
          const item = pending.get(frame.id);
          if (!item) {
            candidate.destroy();
            return;
          }
          pending.delete(frame.id);
          clearTimeout(item.timer);
          item.resolve(frame.outcome);
        }
      }
    });
    candidate.on("error", () => {
      if (socket === candidate) invalidate();
    });
    candidate.on("close", () => {
      clearTimeout(helloTimer);
      if (socket === candidate) invalidate();
    });
  };
  const timer = setInterval(() => {
    if (closed) return;
    if (current && descriptor) {
      const fresh = readDescriptor(dataDir, build, bundle);
      if (
        !fresh ||
        fresh.identity !== descriptor.identity ||
        fresh.session !== descriptor.session ||
        fresh.token !== descriptor.token
      )
        invalidate();
    }
    if (!socket) connectOnce();
  }, 2000);
  timer.unref();
  connectOnce();
  return {
    changes: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    isCurrent: () => {
      if (!current || closed || !descriptor) return false;
      const fresh = readDescriptor(dataDir, build, bundle);
      if (
        !fresh ||
        fresh.identity !== descriptor.identity ||
        fresh.session !== descriptor.session ||
        fresh.token !== descriptor.token
      ) {
        invalidate();
        return false;
      }
      return true;
    },
    status: () => (current ? status : { availability: "unavailable" }),
    act(action, enabled) {
      if (!current || !socket || !descriptor)
        return Promise.resolve({ kind: "refused", reason: "capability_unavailable" });
      if (pending.size >= 4 || socket.writableLength > MAX_FRAME)
        return Promise.resolve({ kind: "refused", reason: "busy" });
      const fresh = readDescriptor(dataDir, build, bundle);
      if (
        !fresh ||
        fresh.identity !== descriptor.identity ||
        fresh.session !== descriptor.session ||
        fresh.token !== descriptor.token
      ) {
        invalidate();
        return Promise.resolve({ kind: "refused", reason: "capability_unavailable" });
      }
      if (
        !["check", "install", "skip", "dismiss", "auto"].includes(action) ||
        (action === "auto" && typeof enabled !== "boolean")
      )
        return Promise.resolve({ kind: "refused", reason: "invalid_input" });
      while (pending.has(nextId)) nextId = nextId >= 2 ** 31 - 1 ? 1 : nextId + 1;
      const id = nextId;
      nextId = nextId >= 2 ** 31 - 1 ? 1 : nextId + 1;
      const active = socket;
      return new Promise((resolve) => {
        const requestTimer = setTimeout(() => {
          pending.delete(id);
          resolve({ kind: "outcome_unknown", reason: "bridge_timeout" });
          invalidate();
        }, 60_000);
        pending.set(id, { resolve, timer: requestTimer });
        const frame = { t: "action", id, action, ...(enabled === undefined ? {} : { enabled }) };
        const encoded = `${JSON.stringify(frame)}\n`;
        if (Buffer.byteLength(encoded) > MAX_FRAME) {
          pending.delete(id);
          clearTimeout(requestTimer);
          resolve({ kind: "refused", reason: "invalid_input" });
          return;
        }
        active.write(encoded, (error) => {
          if (error) invalidate();
        });
      });
    },
    close() {
      closed = true;
      clearInterval(timer);
      invalidate();
      listeners.clear();
    },
  };
}
