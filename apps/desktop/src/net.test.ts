import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { chooseLoopbackPort, isPortFree } from "./net.js";

function hold(port: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen({ port, host: "127.0.0.1" }, () => {
      const bound = (server.address() as { port: number }).port;
      resolve({ port: bound, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

describe("loopback port choice (shell.bind_loopback)", () => {
  it("reuses the remembered port while it is free and falls back when it is taken", async () => {
    const probe = await hold(0);
    await probe.close();
    expect(await chooseLoopbackPort(probe.port)).toBe(probe.port);

    const taken = await hold(0);
    try {
      const port = await chooseLoopbackPort(taken.port);
      expect(port).not.toBe(taken.port);
      expect(port).toBeGreaterThan(1023);
      expect(await isPortFree(taken.port)).toBe(false);
    } finally {
      await taken.close();
    }
  });

  it("picks a random free port without a preference", async () => {
    const port = await chooseLoopbackPort();
    expect(port).toBeGreaterThan(1023);
    expect(await isPortFree(port)).toBe(true);
  });
});
