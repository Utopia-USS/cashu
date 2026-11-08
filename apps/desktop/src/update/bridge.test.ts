import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startMainUpdateBridge } from "./bridge.js";
import type { UpdateController } from "./controller.js";

const roots: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "cashu-update-"));
  roots.push(root);
  return root;
}

/** A controller with a ready update; `act` and the retry predicate come from the test. */
function readyController(
  act: (action: string) => Promise<unknown>,
  canRetryInstallAfterAttempt: () => boolean,
) {
  return {
    status: () => ({
      availability: "ready",
      current: "1.0.0",
      latest: "1.2.3",
      url: null,
      branchAvailable: false,
      manualCheck: true,
      autoCheck: true,
      app: { stage: "available", version: "1.2.3", progress: null, error: null },
    }),
    act,
    canRetryInstallAfterAttempt,
    onChange: () => () => undefined,
    dispose: () => undefined,
  } as unknown as UpdateController;
}

/** Starts the bridge, connects as the authenticated host and collects its newline-delimited replies. */
async function connectedHost(controller: UpdateController) {
  const bridge = await startMainUpdateBridge(
    controller,
    tempRoot(),
    "build-1",
    "bundle-fingerprint",
  );
  const socket = connect(bridge.descriptor.socket);
  cleanups.push(() => bridge.close());
  cleanups.push(() => {
    socket.destroy();
  });
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
  const send = (frame: object) => socket.write(`${JSON.stringify(frame)}\n`);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  send({
    t: "hello",
    token: bridge.descriptor.token,
    session: bridge.descriptor.session,
    build: "build-1",
    bundle: "bundle-fingerprint",
  });
  await vi.waitFor(() => expect(received).toHaveLength(1));
  return { socket, received, send };
}

it("acknowledges install before host drain and never reports installation complete", async () => {
  let resolveDrain: (() => void) | undefined;
  const drain = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  const act = vi.fn(async (action: string) => {
    if (action === "install") await drain;
    return { kind: "outcome_unknown" as const, reason: "install_dispatched" };
  });
  const host = await connectedHost(readyController(act, () => false));
  host.send({ t: "action", id: 1, action: "install" });
  await vi.waitFor(() => expect(host.received).toHaveLength(2));
  expect(host.received[1]).toMatchObject({
    t: "result",
    id: 1,
    outcome: { kind: "outcome_unknown", reason: "install_scheduled" },
  });
  host.socket.destroy(); // The authenticated host may exit as soon as it receives the ACK.
  resolveDrain?.();
  await vi.waitFor(() => expect(act).toHaveBeenCalledWith("install"));
});

it("releases a scheduled install only after proven pre-dispatch refusal", async () => {
  let retrySafe = false;
  const act = vi.fn(async () => {
    if (act.mock.calls.length === 1) {
      retrySafe = true;
      return { kind: "outcome_unknown" as const, reason: "download_unconfirmed" };
    }
    retrySafe = false;
    return { kind: "outcome_unknown" as const, reason: "install_dispatched" };
  });
  const host = await connectedHost(readyController(act, () => retrySafe));
  host.send({ t: "action", id: 1, action: "install" });
  await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(retrySafe).toBe(true));
  await new Promise<void>((resolve) => setImmediate(resolve));
  host.send({ t: "action", id: 2, action: "install" });
  await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(2));
  host.send({ t: "action", id: 3, action: "install" });
  await vi.waitFor(() => expect(host.received).toHaveLength(4));
  expect(host.received[3]).toMatchObject({
    outcome: { kind: "refused", reason: "install_already_scheduled" },
  });
});

it("cancels a scheduled install when the ACK write closes before confirmation", async () => {
  const act = vi.fn(async () => ({ kind: "completed" as const }));
  const host = await connectedHost(readyController(act, () => true));
  const originalWrite = Socket.prototype.write;
  cleanups.push(() => {
    Socket.prototype.write = originalWrite;
  });
  Socket.prototype.write = function (this: Socket, ...args: unknown[]) {
    if (String(args[0]).includes('"install_scheduled"')) {
      this.destroy();
      return true;
    }
    return Reflect.apply(originalWrite, this, args);
  } as typeof Socket.prototype.write;
  host.send({ t: "action", id: 1, action: "install" });
  await new Promise<void>((resolve) => host.socket.once("close", resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(act).not.toHaveBeenCalled();
});

it("uses a short private socket directory for a long data path", async () => {
  const dataDir = join(tempRoot(), "d".repeat(90));
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
