// The sync service's lifecycle in the host (S56c): off without a configuration, not started in safe
// mode, uninitialized without a linked vault, the wake-up iteration at start, the outbox poll, the
// serialized `run --once`, a block that stops the loop, single instance per vault (exclusive opens),
// stop. A synthetic Python database, a fake `cashu` CLI run as a real child (testing/fakeCashu.ts),
// real vaults in a temp lab under a fake home. Synthetic data only.
import { join } from "node:path";
import { acquireHostLock } from "@cashu/node-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { takeWriterLease } from "../lease.js";
import { memoryLog } from "../log.js";
import { cleanup, tempDir } from "../testing/harness.js";
import { Loop } from "./loop.js";
import { type Line, SyncService, type SyncServiceOptions } from "./service.js";
import { closeLabs, GID_A, GID_B, lab } from "./testing/lab.js";

const open: SyncService[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop();
  vi.restoreAllMocks();
  closeLabs();
  cleanup();
});

async function start(
  dataDir: string,
  home: string,
  over: Partial<SyncServiceOptions> = {},
): Promise<{ service: SyncService; log: ReturnType<typeof memoryLog> }> {
  const lock = acquireHostLock(join(tempDir("cashu-lock-"), "host.lock.db"));
  if (lock === undefined) throw new Error("lock");
  const log = memoryLog();
  const service = await SyncService.start({
    dataDir,
    home,
    lease: takeWriterLease(lock),
    log,
    capabilities: { jobs: true, network: true },
    ...over,
  });
  open.push(service);
  return { service, log };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("the sync service", () => {
  it("is off without a configuration", async () => {
    const dir = tempDir();
    const { service } = await start(dir, tempDir("cashu-home-"));
    expect(service.status()).toEqual({ state: "off", vaults: [] });
    expect(await service.runOnce(() => undefined)).toEqual({ kind: "refused", reason: "off" });
  });

  it("does not start in safe mode (no network after a crash loop)", async () => {
    const l = await lab(1);
    const { service, log } = await start(l.py.dir, l.home, {
      capabilities: { jobs: false, network: false },
    });
    expect(service.status().state).toBe("safe-mode");
    expect((await service.runOnce(() => undefined)).kind).toBe("refused");
    expect(log.lines.join("")).toContain("sync.not-started");
    expect(l.py.pending()).toBe(0);
  });

  it("refuses a configuration that names keys outside the lab", async () => {
    const l = await lab(1, {
      keys: { kind: "lab-file", path: join(tempDir(), "k.json"), pythonKeyring: "/tmp/x.json" },
    });
    const { service } = await start(l.py.dir, l.home);
    expect(service.status()).toMatchObject({ state: "refused", reason: "config" });
  });

  it("waits for `bridge init` without a linked vault (review F6)", async () => {
    const l = await lab(0);
    l.py.profile(1, "syn-1");
    const { service } = await start(l.py.dir, l.home);
    expect(service.status().state).toBe("uninitialized");
    expect(await service.runOnce(() => undefined)).toEqual({
      kind: "refused",
      reason: "uninitialized",
    });
  });

  it("ships at start (the wake-up), then on each outbox change, and run --once streams its lines", async () => {
    const l = await lab(1);
    l.py.editAlert(1, 5, GID_A, "bridge-test-1");
    const { service, log } = await start(l.py.dir, l.home);
    await until(() => l.py.pending() === 0 && service.status().state === "idle");
    expect(log.lines.join("")).toContain('"event":"sync.progress","point":"acked"');

    l.py.editAlert(1, 6, GID_B, "bridge-test-2");
    await until(() => l.py.pending() === 0 && service.status().state === "idle");

    const lines: Line[] = [];
    expect(await service.runOnce((line) => lines.push(line))).toEqual({
      kind: "idle",
      iterations: 1,
    });
    expect(lines.map((x) => x.step)).toEqual(["sync", "pipe"]);
    expect(service.status()).toMatchObject({
      state: "idle",
      pending: 0,
      vaults: [{ ordinal: 0, intentOpen: false, pipeSeq: expect.any(Number) }],
    });
    const shipped = log.lines.filter((x) => x.includes('"event":"sync.ship"'));
    expect(shipped.length).toBe(2);
  });

  it("stops on a block and stays stopped until run --once gets past it (D4)", async () => {
    const l = await lab(1);
    l.py.editAlert(1, 5, GID_A, "bridge-test-1", { kind: "new_high" });
    const { service } = await start(l.py.dir, l.home);
    await until(() => service.status().state === "blocked");
    expect(service.status().reason).toBe("immutable:alerts:kind");
    expect(l.py.pending()).toBe(1);
    const lines: Line[] = [];
    expect((await service.runOnce((line) => lines.push(line))).kind).toBe("blocked");
    expect(lines.some((x) => "blocked" in x)).toBe(true);
  });

  it("continues a bounded turn on the next poll without waiting for another outbox change", async () => {
    const l = await lab(1);
    l.py.editAlert(1, 5, GID_A, "bridge-test-1");
    const iteration = Loop.prototype.iteration;
    let calls = 0;
    // Exercise the turn boundary without generating 1000 outbox transactions. The last call uses
    // the real loop, including durable write and ack. A fixed clock keeps the carrier from firing.
    vi.spyOn(Loop.prototype, "iteration").mockImplementation(function (this: Loop) {
      calls += 1;
      if (calls <= 20) return Promise.resolve({ idle: false, plans: 0, rows: 0, events: 0 });
      return iteration.call(this);
    });
    const { service } = await start(l.py.dir, l.home, {
      now: () => Date.UTC(2026, 2, 2),
    });
    await until(() => l.py.pending() === 0 && service.status().state === "idle");
    expect(calls).toBe(21);
    expect(service.status().vaults.every((v) => !v.intentOpen)).toBe(true);
  });

  it("polls an edit arriving after an iteration observed an empty outbox", async () => {
    const l = await lab(1);
    const iteration = Loop.prototype.iteration;
    let calls = 0;
    vi.spyOn(Loop.prototype, "iteration").mockImplementation(async function (this: Loop) {
      const result = await iteration.call(this);
      calls += 1;
      // The shipping result is already idle, but Python may edit while sync/pipe is awaited.
      if (calls === 1) l.py.editAlert(1, 5, GID_A, "bridge-test-1");
      return result;
    });
    const { service } = await start(l.py.dir, l.home, {
      now: () => Date.UTC(2026, 2, 2),
    });
    await until(() => calls >= 2 && l.py.pending() === 0 && service.status().state === "idle");
    expect(calls).toBe(2);
    expect(service.status().vaults.every((v) => !v.intentOpen)).toBe(true);
  });

  it("is the single writer of its vaults: a second service on the same state root is refused", async () => {
    const l = await lab(1);
    const { service } = await start(l.py.dir, l.home);
    await until(() => service.status().state === "idle");
    // Another host (its own lock: another data dir naming the same state root) cannot open them.
    const { service: second } = await start(l.py.dir, l.home);
    expect(second.status()).toMatchObject({ state: "refused", reason: "vault-busy" });
    expect(service.status().state).toBe("idle");
  });

  it("finishes the current iteration on stop and closes its vaults", async () => {
    const l = await lab(2);
    l.py.editAlert(1, 5, GID_A, "bridge-test-1");
    l.py.editAlert(2, 6, GID_B, "bridge-test-2");
    let reached = false;
    const { service } = await start(l.py.dir, l.home, {
      at: (p) => {
        if (p === "intent") reached = true;
      },
    });
    await until(() => reached);
    await service.stop();
    expect(service.status().state).toBe("stopped");
    expect(l.py.pending()).toBe(0); // the plan that had started was written and acked
    // Reopened (as by the next host): nothing left open, nothing pending.
    const { service: next } = await start(l.py.dir, l.home);
    await until(() => next.status().state === "idle");
    expect(next.status().vaults.every((v) => !v.intentOpen)).toBe(true);
  });
});
