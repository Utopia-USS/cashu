import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startMainUpdateBridge } from "./bridge.js";
import type { UpdateController } from "./controller.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("acknowledges install before host drain and never reports installation complete", async () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-update-"));
  roots.push(root);
  let activeHostAction = 1;
  let resolveDrain: (() => void) | undefined;
  const drain = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  const act = vi.fn(async (action: string) => {
    if (action === "install") await drain;
    return { kind: "outcome_unknown" as const, reason: "install_dispatched" };
  });
  const controller = {
    status: () => ({
      availability: "ready",
      current: "1.0.0",
      latest: "1.2.3",
      url: null,
      branchAvailable: false,
      manualCheck: true,
      app: { stage: "available", version: "1.2.3", progress: null, error: null },
    }),
    act,
    canRetryInstallAfterAttempt: () => false,
    onChange: () => () => undefined,
    dispose: () => undefined,
  } as unknown as UpdateController;
  const bridge = await startMainUpdateBridge(controller, root, "build-1", "bundle-fingerprint");
  try {
    const socket = connect(bridge.descriptor.socket);
    const received: unknown[] = [];
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        received.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `${JSON.stringify({
        t: "hello",
        token: bridge.descriptor.token,
        session: bridge.descriptor.session,
        build: "build-1",
        bundle: "bundle-fingerprint",
      })}\n`,
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    socket.write(`${JSON.stringify({ t: "action", id: 1, action: "install" })}\n`);
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toMatchObject({
      t: "result",
      id: 1,
      outcome: { kind: "outcome_unknown", reason: "install_scheduled" },
    });
    socket.destroy(); // The authenticated host may exit as soon as it receives the ACK.
    activeHostAction--;
    if (activeHostAction === 0) resolveDrain?.();
    await vi.waitFor(() => expect(act).toHaveBeenCalledWith("install"));
  } finally {
    await bridge.close();
  }
});

it("releases a scheduled install only after proven pre-dispatch refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-update-"));
  roots.push(root);
  let retrySafe = false;
  const act = vi.fn(async () => {
    if (act.mock.calls.length === 1) {
      retrySafe = true;
      return { kind: "outcome_unknown" as const, reason: "download_unconfirmed" };
    }
    retrySafe = false;
    return { kind: "outcome_unknown" as const, reason: "install_dispatched" };
  });
  const controller = {
    status: () => ({
      availability: "ready",
      current: "1.0.0",
      latest: "1.2.3",
      url: null,
      branchAvailable: false,
      manualCheck: true,
      app: { stage: "available", version: "1.2.3", progress: null, error: null },
    }),
    act,
    canRetryInstallAfterAttempt: () => retrySafe,
    onChange: () => () => undefined,
    dispose: () => undefined,
  } as unknown as UpdateController;
  const bridge = await startMainUpdateBridge(controller, root, "build-1", "bundle-fingerprint");
  const socket = connect(bridge.descriptor.socket);
  const received: unknown[] = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      received.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  try {
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `${JSON.stringify({ t: "hello", token: bridge.descriptor.token, session: bridge.descriptor.session, build: "build-1", bundle: "bundle-fingerprint" })}\n`,
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    socket.write(`${JSON.stringify({ t: "action", id: 1, action: "install" })}\n`);
    await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(controller.canRetryInstallAfterAttempt()).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.write(`${JSON.stringify({ t: "action", id: 2, action: "install" })}\n`);
    await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(2));
    socket.write(`${JSON.stringify({ t: "action", id: 3, action: "install" })}\n`);
    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received[3]).toMatchObject({
      outcome: { kind: "refused", reason: "install_already_scheduled" },
    });
  } finally {
    socket.destroy();
    await bridge.close();
  }
});

it("cancels a scheduled install when the ACK write closes before confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-update-"));
  roots.push(root);
  const act = vi.fn(async () => ({ kind: "completed" as const }));
  const controller = {
    status: () => ({
      availability: "ready",
      current: "1.0.0",
      latest: "1.2.3",
      url: null,
      branchAvailable: false,
      manualCheck: true,
      app: { stage: "available", version: "1.2.3", progress: null, error: null },
    }),
    act,
    canRetryInstallAfterAttempt: () => true,
    onChange: () => () => undefined,
    dispose: () => undefined,
  } as unknown as UpdateController;
  const bridge = await startMainUpdateBridge(controller, root, "build-1", "bundle-fingerprint");
  const originalWrite = Socket.prototype.write;
  const socket = connect(bridge.descriptor.socket);
  const received: unknown[] = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      received.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  try {
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `${JSON.stringify({ t: "hello", token: bridge.descriptor.token, session: bridge.descriptor.session, build: "build-1", bundle: "bundle-fingerprint" })}\n`,
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    Socket.prototype.write = function (this: Socket, ...args: unknown[]) {
      if (String(args[0]).includes('"install_scheduled"')) {
        this.destroy();
        return true;
      }
      return Reflect.apply(originalWrite, this, args);
    } as typeof Socket.prototype.write;
    socket.write(`${JSON.stringify({ t: "action", id: 1, action: "install" })}\n`);
    await new Promise<void>((resolve) => socket.once("close", resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(act).not.toHaveBeenCalled();
  } finally {
    Socket.prototype.write = originalWrite;
    socket.destroy();
    await bridge.close();
  }
});

it("uses a short private socket directory for a long data path", async () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-update-"));
  roots.push(root);
  const dataDir = join(root, "d".repeat(90));
  mkdirSync(dataDir, { mode: 0o700 });
  const controller = {
    status: () => ({ availability: "unavailable" }),
    onChange: () => () => undefined,
    dispose: () => undefined,
  } as unknown as UpdateController;
  const bridge = await startMainUpdateBridge(controller, dataDir, "build-1", "bundle-fingerprint");
  try {
    expect(Buffer.byteLength(bridge.descriptor.socket)).toBeLessThanOrEqual(100);
  } finally {
    await bridge.close();
  }
});
