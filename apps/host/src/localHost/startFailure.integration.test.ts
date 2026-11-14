// A start that fails after the stores opened: the host releases what started, closes the stores and the
// server and never stops itself later. Synthetic data only: a generated vault.
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { memoryLog } from "../log.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";

afterEach(cleanup);

const LINGER_MS = 30;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const injected = new Error("synthetic_late_start_failure");

/**
 * Options whose `budgetClassifiers` throws when read: the hosted command tree reads it after the
 * pairing service and the worker, before the MCP sessions exist.
 */
function failingLate<T extends object>(options: T): T {
  return Object.defineProperty({ ...options }, "budgetClassifiers", {
    enumerable: true,
    get() {
      throw injected;
    },
  });
}

it("aborts a native start that fails late, then starts again", async () => {
  const fixture = await nativeVaultFixture();
  try {
    const base = {
      dataDir: fixture.dataDir,
      home: fixture.home,
      vaultSource: fixture.vaultSource,
      launcher: false,
      lingerMs: LINGER_MS,
    };
    const log = memoryLog();
    await expect(startLocalHost(failingLate({ ...base, log }))).rejects.toBe(injected);

    // At once, before any linger: the lock and the stores' exclusive opens are free.
    const again = memoryLog();
    const host = await startLocalHost({ ...base, lingerMs: 60_000, log: again });
    try {
      // Past the linger of the failed start: no idle timer of it ever fires a stop.
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
