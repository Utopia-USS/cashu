// A start that fails after the stores opened: the host releases what started, closes the stores and the
// server and never stops itself later. The native case resumes the LAN listener first (a pending
// pairing attempt is the persisted opt-in), which arms the idle timer before the injected failure.
// Synthetic data only: a generated vault and a fabricated pending attempt row.
import { createServer } from "node:net";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { memoryLog } from "../log.js";
import { PairingJournal } from "../pairing/journal.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";

afterEach(cleanup);

const LINGER_MS = 30;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const injected = new Error("synthetic_late_start_failure");

/**
 * Options whose `budgetClassifiers` throws when read: the hosted command tree reads it after the LAN
 * resume and the worker, before the MCP sessions exist.
 */
function failingLate<T extends object>(options: T): T {
  return Object.defineProperty({ ...options }, "budgetClassifiers", {
    enumerable: true,
    get() {
      throw injected;
    },
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no_port");
  return address.port;
}

/** A pending (may_append) pairing attempt: the host resumes LAN serving at start. */
function seedPendingPairing(dataDir: string, vault: string): void {
  const db = openNodeSqlite(join(dataDir, "vaults", vault, "private.db"));
  try {
    new PairingJournal(db).prepare({
      session: "s".repeat(32),
      operationId: "o".repeat(32),
      vault,
      device: "d".repeat(32),
      signKey: "synthetic-sign-key",
      boxKey: "synthetic-box-key",
      certificate: "synthetic-certificate",
      event: { type: "synthetic" } as never,
      eid: "e".repeat(32),
      digest: "synthetic-digest",
      welcome: new Uint8Array([1]),
      pages: [],
      phase: "may_append",
    });
  } finally {
    db.close();
  }
}

it("aborts a start that fails after the LAN resume armed the idle timer, then starts again", async () => {
  const fixture = await nativeVaultFixture();
  try {
    seedPendingPairing(fixture.dataDir, fixture.vaultId);
    const port = await freePort();
    const base = {
      dataDir: fixture.dataDir,
      home: fixture.home,
      vaultSource: fixture.vaultSource,
      launcher: false,
      lan: { kind: "loopback" as const, port },
      lingerMs: LINGER_MS,
    };
    const log = memoryLog();
    await expect(startLocalHost(failingLate({ ...base, log }))).rejects.toBe(injected);

    // At once, before any linger: the lock, the stores' exclusive opens and the LAN port are free.
    const again = memoryLog();
    const host = await startLocalHost({ ...base, lingerMs: 60_000, log: again });
    try {
      expect(host.lan?.address.port).toBe(port);
      expect(again.lines.some((line) => line.includes("host.lan-unavailable"))).toBe(false);
      // Past the linger of the failed start: its idle timer (armed by the LAN resume) never fires a
      // stop, which used to reject with a ReferenceError on the services declared after it.
      await wait(LINGER_MS * 4);
      expect(log.lines.some((line) => line.includes("host.stopping"))).toBe(false);
      expect(host.status().pid).toBe(process.pid);
    } finally {
      await host.stop();
    }
    expect(log.lines.some((line) => line.includes("host.start-failed"))).toBe(true);
    expect(log.lines.some((line) => line.includes("host.start-aborted"))).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

it("closes the synthetic stores and the lock when wiring fails after they opened", async () => {
  const dir = tempDir();
  const log = memoryLog();
  await expect(
    startLocalHost(failingLate({ ...testHostOptions(dir), log, lingerMs: LINGER_MS })),
  ).rejects.toBe(injected);
  const host = await startLocalHost(testHostOptions(dir));
  try {
    expect(host.stores.vaults.size).toBeGreaterThan(0);
    await wait(LINGER_MS * 4);
    expect(log.lines.some((line) => line.includes("host.stopping"))).toBe(false);
  } finally {
    await host.stop();
  }
  expect(log.lines.some((line) => line.includes("host.start-aborted"))).toBe(true);
});
