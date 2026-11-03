import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir, hostRunPaths } from "@cashu/node-host";
import { afterEach, expect, it, vi } from "vitest";
import { hostUpdateBridge } from "./updateBridge.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("accepts only exact build/session and becomes unavailable on main disconnect", async () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-update-"));
  roots.push(root);
  const session = randomUUID();
  const token = randomBytes(32).toString("hex");
  const paths = hostRunPaths(root);
  ensurePrivateDir(paths.socketDir);
  const path = join(paths.socketDir, `u-${randomBytes(6).toString("hex")}.sock`);
  let peer: Socket | undefined;
  const server = createServer((socket) => {
    peer = socket;
    socket.once("data", (chunk) => {
      const hello = JSON.parse(chunk.toString().trim());
      if (hello.token !== token) {
        socket.destroy();
        return;
      }
      socket.write(
        `${JSON.stringify({
          t: "ready",
          session,
          build: "build-1",
          bundle: "fingerprint",
          status: { availability: "unavailable" },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  chmodSync(path, 0o600);
  writeFileSync(
    join(root, "update-main-capability.json"),
    JSON.stringify({
      schema: 1,
      socket: path,
      token,
      session,
      build: "build-1",
      bundle: "fingerprint",
      pid: process.pid + 1,
    }),
    { mode: 0o600 },
  );
  const bridge = hostUpdateBridge(root, "build-1", "fingerprint");
  try {
    await vi.waitFor(() => expect(bridge.isCurrent()).toBe(true));
    const pending = bridge.act("check");
    peer?.destroy();
    expect(await pending).toEqual({ kind: "outcome_unknown", reason: "bridge_disconnected" });
    await vi.waitFor(() => expect(bridge.isCurrent()).toBe(false));
    expect(bridge.status()).toEqual({ availability: "unavailable" });
  } finally {
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
