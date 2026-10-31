/// <reference types="node" />
import { createServer } from "node:net";

export const LOOPBACK = "127.0.0.1";

function tryBind(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(null));
    server.listen({ port, host: LOOPBACK, exclusive: true }, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : null;
      server.close(() => resolve(bound));
    });
  });
}

/**
 * A free port on 127.0.0.1: `preferred` when it is free, else a random one (shell.bind_loopback).
 * The probe socket is closed again because `cashu serve` binds the port itself; the sidecar launch
 * therefore checks that its own process bound it (see sidecar.ts).
 */
export async function chooseLoopbackPort(preferred?: number | null): Promise<number> {
  for (const port of preferred ? [preferred, 0] : [0]) {
    const bound = await tryBind(port);
    if (bound) return bound;
  }
  throw new Error("No free port on 127.0.0.1");
}

/** True when nothing listens on 127.0.0.1:`port` (tests, drain checks after quit). */
export async function isPortFree(port: number): Promise<boolean> {
  return (await tryBind(port)) !== null;
}
