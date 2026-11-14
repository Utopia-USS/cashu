// What the engine reports about the health of its remotes and writer streams, apart from the data:
// the pull status the pinned lease relies on while a remote is unreachable (D6), the push budget of one
// pass (S6) and the persisted per-writer stuck records (D7). Synthetic vaults and the insecure test
// codec only.
import { describe, expect, it } from "vitest";
import type {
  FrameCodec,
  FrameGate,
  GateStateStore,
  GateVerdict,
  StuckRecord,
  SyncEngine,
  Transport,
} from "./carrier.js";
import { createSyncEngine, stuckKind } from "./engine.js";
import { FrameRejectedError, TransportError, type TransportUnavailableReason } from "./errors.js";
import {
  FaultInjector,
  insecureTestCodec,
  insecureTestGate,
  ManualClock,
  MemorySink,
} from "./testing/index.js";
import { MemoryClockStore, MemoryTransport } from "./testing/memory.js";

const VAULT = "0123456789abcdef0123456789abcdef";
const A = "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T0 = Date.UTC(2026, 10, 14, 10, 12);
const ev = (i: string) => ({ t: "test.set", v: 1, i, g: i, d: { value: i } });
const always = () => true;

interface Rig {
  readonly codec?: FrameCodec;
  readonly gate?: FrameGate;
  readonly gateState?: GateStateStore;
  readonly local?: Transport;
  readonly sink?: MemorySink;
  readonly maxPushBytesPerPass?: number;
  readonly pullHistory?: { lastCompleteAt?: number; pausedSince?: number };
}

function open(
  device: string,
  remotes: Transport[],
  clock: ManualClock,
  rig: Rig = {},
): Promise<SyncEngine> {
  return createSyncEngine({
    vault: VAULT,
    device,
    local: rig.local ?? new MemoryTransport(),
    remotes,
    codec: rig.codec ?? insecureTestCodec(),
    gate: rig.gate ?? insecureTestGate(),
    sink: rig.sink ?? new MemorySink(),
    clockStore: new MemoryClockStore(),
    clockGuard: { load: () => ({}), save: () => {} },
    physicalClock: clock,
    ...(rig.gateState ? { gateState: rig.gateState } : {}),
    ...(rig.maxPushBytesPerPass === undefined
      ? {}
      : { maxPushBytesPerPass: rig.maxPushBytesPerPass }),
    ...(rig.pullHistory === undefined ? {} : { pullHistory: rig.pullHistory }),
  });
}

/**
 * A remote that, while `down` names a reason, answers every call `unavailable` with it (the Firestore
 * transport's mapping: a deleted member doc is `refused`, a replaced identity `identity-lost`).
 */
function refusing(inner: Transport): Transport & { down: TransportUnavailableReason | null } {
  const remote = {
    down: null as TransportUnavailableReason | null,
    consistency: inner.consistency,
    check(): void {
      if (remote.down !== null) throw new TransportError("unavailable", "synthetic", remote.down);
    },
    list: async (v: string) => {
      remote.check();
      return inner.list(v);
    },
    read: async (v: string, d: string, sg: number, o: number) => {
      remote.check();
      return inner.read(v, d, sg, o);
    },
    append: async (v: string, d: string, sg: number, o: number, b: Uint8Array) => {
      remote.check();
      return inner.append(v, d, sg, o, b);
    },
  };
  return remote;
}

const pullOf = (e: SyncEngine) => e.fetchLeaseEvidence(always, always).pull;

/** B writes `n` single-event frames and pushes them to `remote`. */
async function writer(remote: Transport, clock: ManualClock, n = 1): Promise<SyncEngine> {
  const b = await open(B, [remote], clock);
  for (let i = 0; i < n; i++) await b.write([ev(`b${i}`)]);
  await b.sync();
  return b;
}

describe("D6: pull status", () => {
  it("is offline only while every miss is an unreachable remote; since survives, reachedAt moves", async () => {
    const clock = new ManualClock(T0);
    const lan = new MemoryTransport();
    const relay = new FaultInjector(new MemoryTransport());
    const a = await open(A, [lan, relay], clock);
    expect(pullOf(a)).toEqual({ kind: "incomplete" }); // no pass yet
    await a.write([ev("a1")]);
    await a.sync();
    expect(pullOf(a)).toEqual({ kind: "pulled" });
    relay.setOnline(false);
    clock.advance(60_000);
    const first = await a.sync();
    expect(first.offlineRemotes).toBe(1);
    expect(pullOf(a)).toEqual({ kind: "offline", since: T0 + 60_000, reachedAt: T0 + 60_000 });
    // The complete pull stays the evidence; the offline pass is reported beside it.
    expect(a.fetchLeaseEvidence(always, always).lastPullAt).toBe(T0);
    clock.advance(5 * 60_000);
    await a.write([ev("a2")]);
    await a.sync();
    expect(pullOf(a)).toEqual({ kind: "offline", since: T0 + 60_000, reachedAt: T0 + 360_000 });
    relay.setOnline(true);
    clock.advance(60_000);
    await a.sync();
    expect(pullOf(a)).toEqual({ kind: "pulled" });
    expect(a.fetchLeaseEvidence(always, always).lastPullAt).toBe(T0 + 420_000);
    // A suspect clock reports nothing it could rely on.
    clock.set(T0 - 60 * 60_000);
    expect(a.fetchLeaseEvidence(always, always)).toMatchObject({
      clockOk: false,
      pull: { kind: "incomplete" },
    });
  });

  it("a vault without remotes never reports offline", async () => {
    const clock = new ManualClock(T0);
    const a = await open(A, [], clock);
    await a.write([ev("a1")]);
    await a.sync();
    expect(pullOf(a)).toEqual({ kind: "incomplete" });
  });

  it("a rollback or an upgrade need is never offline, even with the relay down", async () => {
    const clock = new ManualClock(T0);
    const lan = new MemoryTransport();
    const relay = new FaultInjector(new MemoryTransport());
    const a = await open(A, [lan, relay], clock);
    await a.write([ev("a1")]);
    await a.sync();
    // A restored backup: the folder holds own bytes this copy never wrote.
    relay.setOnline(false);
    const restored = await open(A, [lan, relay], clock);
    const rolled = await restored.sync();
    expect(rolled.rolledBack).toBe(true);
    expect(pullOf(restored)).toEqual({ kind: "incomplete" });

    // A newer frame format from B: upgrade the app.
    const lan2 = new MemoryTransport();
    await writer(lan2, clock);
    const base = insecureTestCodec();
    const newer: FrameCodec = {
      ...base,
      open: (sealed, at, prev) => {
        if (at.device === B) throw new FrameRejectedError("frame-format");
        return base.open(sealed, at, prev);
      },
    };
    const reader = await open(A, [lan2, relay], clock, { codec: newer });
    const upgrade = await reader.sync();
    expect(upgrade.needsUpgrade).toBe(true);
    expect(upgrade.offlineRemotes).toBe(1);
    expect(pullOf(reader)).toEqual({ kind: "incomplete" });
  });

  it("a failed pass or a reachable remote left undelivered is incomplete", async () => {
    const clock = new ManualClock(T0);
    const lan = new MemoryTransport();
    const relay = new FaultInjector(new MemoryTransport());
    const a = await open(A, [lan, relay], clock, { maxPushBytesPerPass: 1 });
    for (let i = 0; i < 3; i++) await a.write([ev(`a${i}`)]);
    relay.setOnline(false);
    // G3: the folder answered and was pulled completely; only the push budget left own frames for
    // it. That alone does not spoil the pass: with the relay down it is `offline`.
    const capped = await a.sync();
    expect(capped.pushPending).toBe(true);
    expect(pullOf(a)).toEqual({ kind: "offline", since: T0, reachedAt: T0 });
    // An offset conflict on a remote that answered is a reachable remote left undelivered.
    const conflicting: Transport = {
      consistency: lan.consistency,
      list: async () => [],
      read: async () => new Uint8Array(),
      append: async () => {
        throw new TransportError("offset-conflict", "synthetic");
      },
    };
    const d = await open(A, [conflicting, relay], clock);
    await d.write([ev("d1")]);
    await d.sync();
    expect(pullOf(d)).toEqual({ kind: "incomplete" });
    let broken = true;
    const failing: Transport = {
      consistency: lan.consistency,
      list: (v) => {
        if (broken) throw new Error("synthetic remote fault");
        return lan.list(v);
      },
      read: (v, d, s, o) => lan.read(v, d, s, o),
      append: (v, d, s, o, b) => lan.append(v, d, s, o, b),
    };
    const b = await open(B, [failing, relay], clock);
    await expect(b.sync()).rejects.toThrow("synthetic remote fault");
    expect(pullOf(b)).toEqual({ kind: "incomplete" });
    broken = false;
    await b.sync();
    expect(pullOf(b)).toMatchObject({ kind: "offline" });
  });
});

describe("G1: only an outage is offline", () => {
  it("a remote that refuses (member doc gone), lost its identity or speaks garbage is incomplete", async () => {
    for (const reason of ["refused", "identity-lost", "protocol"] as const) {
      const clock = new ManualClock(T0);
      const lan = new MemoryTransport();
      const relay = refusing(new MemoryTransport());
      const a = await open(A, [lan, relay], clock);
      await a.write([ev("a1")]);
      await a.sync();
      expect(pullOf(a)).toEqual({ kind: "pulled" });
      relay.down = reason;
      clock.advance(60_000);
      // Not a throw: the pass goes on with the folder, it just proves nothing for the lease.
      const pass = await a.sync();
      expect(pass.offlineRemotes, reason).toBe(1);
      expect(pullOf(a), reason).toEqual({ kind: "incomplete" });
      expect(a.fetchLeaseEvidence(always, always).lastPullAt, reason).toBe(T0);
    }
  });

  it("an outage (network, quota, the host's back-off) is offline", async () => {
    const clock = new ManualClock(T0);
    const relay = refusing(new MemoryTransport());
    const a = await open(A, [new MemoryTransport(), relay], clock);
    await a.sync();
    relay.down = "outage";
    clock.advance(60_000);
    await a.sync();
    expect(pullOf(a)).toEqual({ kind: "offline", since: T0 + 60_000, reachedAt: T0 + 60_000 });
    // A refusal after the outage ends the offline evidence at once.
    relay.down = "refused";
    clock.advance(60_000);
    await a.sync();
    expect(pullOf(a)).toEqual({ kind: "incomplete" });
  });
});

describe("G3: a capped push is a complete pull", () => {
  it("every capped pass of a large first push refreshes the evidence; the lease transport stays eventual", async () => {
    const clock = new ManualClock(T0);
    const remote = new MemoryTransport();
    const a = await open(A, [remote], clock, { maxPushBytesPerPass: 1 });
    for (let i = 0; i < 4; i++) await a.write([ev(`a${i}`)]);
    let passes = 0;
    for (;;) {
      clock.advance(60_000);
      const at = clock.now();
      const r = await a.sync();
      passes += 1;
      expect(pullOf(a)).toEqual({ kind: "pulled" });
      expect(a.fetchLeaseEvidence(always, always).lastPullAt).toBe(at);
      expect(a.pullHistory()).toEqual({ lastCompleteAt: at });
      if (!r.pushPending) break;
      expect(a.leaseTransport()).toEqual({ kind: "eventual" });
    }
    expect(passes).toBeGreaterThan(2);
  });
});

describe("G2 / G5: pull history", () => {
  it("records the last complete pull and the first pass after it that was not one", async () => {
    const clock = new ManualClock(T0);
    const relay = refusing(new MemoryTransport());
    const a = await open(A, [new MemoryTransport(), relay], clock);
    expect(a.pullHistory()).toEqual({});
    await a.sync();
    expect(a.pullHistory()).toEqual({ lastCompleteAt: T0 });
    relay.down = "outage";
    clock.advance(60_000);
    await a.sync();
    clock.advance(60_000);
    relay.down = "refused";
    await a.sync();
    // The pause starts at the first failed pass and does not move with later ones.
    expect(a.pullHistory()).toEqual({ lastCompleteAt: T0, pausedSince: T0 + 60_000 });
    relay.down = null;
    clock.advance(60_000);
    await a.sync();
    expect(a.pullHistory()).toEqual({ lastCompleteAt: T0 + 180_000 });
  });

  it("starts from the history handed in at open; a pass that throws pauses too; no remotes: none", async () => {
    const clock = new ManualClock(T0);
    let broken = true;
    const lan = new MemoryTransport();
    const failing: Transport = {
      consistency: lan.consistency,
      list: (v) => {
        if (broken) throw new Error("synthetic remote fault");
        return lan.list(v);
      },
      read: (v, d, sg, o) => lan.read(v, d, sg, o),
      append: (v, d, sg, o, b) => lan.append(v, d, sg, o, b),
    };
    const seeded = await open(A, [failing], clock, {
      pullHistory: { lastCompleteAt: T0 - 86_400_000 },
    });
    expect(seeded.pullHistory()).toEqual({ lastCompleteAt: T0 - 86_400_000 });
    await expect(seeded.sync()).rejects.toThrow("synthetic remote fault");
    expect(seeded.pullHistory()).toEqual({ lastCompleteAt: T0 - 86_400_000, pausedSince: T0 });
    broken = false;
    await seeded.sync();
    expect(seeded.pullHistory()).toEqual({ lastCompleteAt: T0 });
    const alone = await open(A, [], clock, {
      pullHistory: { lastCompleteAt: T0, pausedSince: T0 },
    });
    await alone.sync();
    expect(alone.pullHistory()).toEqual({});
  });
});

describe("S6: push budget", () => {
  it("pushes whole frames up to the budget per pass and reports the rest until it is done", async () => {
    const clock = new ManualClock(T0);
    const remote = new MemoryTransport();
    const local = new MemoryTransport();
    const a = await open(A, [remote], clock, { local, maxPushBytesPerPass: 1 });
    for (let i = 0; i < 4; i++) await a.write([ev(`a${i}`)]);
    const size = async (t: Transport) =>
      (await t.list(VAULT)).filter((s) => s.device === A).reduce((n, s) => n + s.size, 0);
    const total = await size(local);
    const passes: { pushed: number; pending: boolean }[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await a.sync();
      passes.push({ pushed: r.pushedBytes, pending: r.pushPending });
      if (!r.pushPending) break;
    }
    // One frame per pass (budget 1 byte, at least one frame moves); then a pass with nothing left.
    expect(passes.length).toBeGreaterThan(2);
    expect(passes.at(-1)?.pending).toBe(false);
    expect(passes.slice(0, -1).every((p) => p.pending && p.pushed > 0)).toBe(true);
    expect(await size(remote)).toBe(total);
    // The remote's copy is a valid stream: a reader applies all four events.
    const sink = new MemorySink();
    const b = await open(B, [remote], clock, { sink });
    await b.sync();
    expect(sink.size).toBe(4);
  });

  it("the default budget pushes a small log in one pass", async () => {
    const clock = new ManualClock(T0);
    const remote = new MemoryTransport();
    const a = await open(A, [remote], clock);
    for (let i = 0; i < 4; i++) await a.write([ev(`a${i}`)]);
    const r = await a.sync();
    expect(r.pushPending).toBe(false);
    expect(r.pushedBytes).toBeGreaterThan(0);
  });
});

/** A gate that answers `verdict` for B's frames while set, the test gate otherwise. */
function steerableGate(): { gate: FrameGate; set(v: GateVerdict | undefined): void } {
  const base = insecureTestGate();
  let verdict: GateVerdict | undefined;
  return {
    gate: {
      ...base,
      authenticate: (head, events) =>
        head.device === B && verdict !== undefined ? verdict : base.authenticate(head, events),
    },
    set(v) {
      verdict = v;
    },
  };
}

function memoryGateState(): GateStateStore & { stuck: string | undefined; saves: number } {
  const store = {
    stuck: undefined as string | undefined,
    saves: 0,
    load: () => undefined,
    save: () => {},
    loadStuck: () => store.stuck,
    saveStuck(state: string) {
      store.stuck = state;
      store.saves += 1;
    },
  };
  return store;
}

describe("D7: stuck records", () => {
  it("classifies the codes", () => {
    expect(stuckKind("revoked_writer")).toBe("final");
    expect(stuckKind("forked")).toBe("final");
    expect(stuckKind("writer-unknown")).toBe("waiting");
    expect(stuckKind("unknown_key")).toBe("waiting");
    for (const code of ["tampered", "bad_head_signature", "malformed", "too-large", "frame-format"])
      expect(stuckKind(code), code).toBe("rejected");
  });

  it.each([
    [{ ok: false, wait: true, code: "unknown_writer" }, "writer-unknown", "waiting"],
    [{ ok: false, wait: false, code: "revoked_writer" }, "revoked_writer", "final"],
    [{ ok: false, wait: false, code: "forked" }, "forked", "final"],
    [{ ok: false, wait: false, code: "bad_head_signature" }, "bad_head_signature", "rejected"],
  ] as const)(
    "records a gate verdict %o, counts passes, persists and clears once the cursor passes",
    async (verdict, code, kind) => {
      const clock = new ManualClock(T0);
      const remote = new MemoryTransport();
      await writer(remote, clock, 2);
      const steer = steerableGate();
      steer.set(verdict);
      const state = memoryGateState();
      const local = new MemoryTransport();
      const sink = new MemorySink();
      const rig = { gate: steer.gate, gateState: state, local, sink };
      const a = await open(A, [remote], clock, rig);
      const first = await a.sync();
      const expected: StuckRecord = {
        device: B,
        seg: 1,
        offset: 0,
        code,
        kind,
        firstSeenAt: T0,
        passes: 1,
      };
      expect(first.stuck).toEqual([expected]);
      expect(sink.size).toBe(0);
      clock.advance(60_000);
      expect((await a.sync()).stuck).toEqual([{ ...expected, passes: 2 }]);
      // Persisted: a reopened engine continues the same record.
      await a.close();
      clock.advance(60_000);
      const reopened = await open(A, [remote], clock, rig);
      expect((await reopened.sync()).stuck).toEqual([{ ...expected, passes: 3 }]);
      const saves = state.saves;
      // A pass that does not meet the frame (the remote is unreachable) keeps it unchanged.
      const offline = new FaultInjector(remote);
      const cut = await open(A, [offline], clock, rig);
      offline.setOnline(false);
      expect((await cut.sync()).stuck).toEqual([{ ...expected, passes: 3 }]);
      expect(state.saves).toBe(saves);
      // The stream moves: the record is gone, and so is its persisted copy.
      steer.set(undefined);
      const healed = await reopened.sync();
      expect(healed.stuck).toEqual([]);
      expect(sink.size).toBe(2);
      expect(JSON.parse(state.stuck ?? "null")).toEqual([]);
    },
  );

  it("a codec without the key waits (unknown_key); a tampered frame is rejected", async () => {
    const clock = new ManualClock(T0);
    const remote = new MemoryTransport();
    await writer(remote, clock);
    const base = insecureTestCodec();
    let failure: string | undefined = "unknown_key";
    const codec: FrameCodec = {
      ...base,
      open: (sealed, at, prev) => {
        if (at.device === B && failure !== undefined) throw new FrameRejectedError(failure);
        return base.open(sealed, at, prev);
      },
    };
    const a = await open(A, [remote], clock, { codec });
    expect((await a.sync()).stuck).toMatchObject([
      { device: B, code: "unknown_key", kind: "waiting" },
    ]);
    // A different code at the same frame is a new record (first seen now, one pass).
    failure = "tampered";
    clock.advance(1_000);
    expect((await a.sync()).stuck).toEqual([
      {
        device: B,
        seg: 1,
        offset: 0,
        code: "tampered",
        kind: "rejected",
        firstSeenAt: T0 + 1_000,
        passes: 1,
      },
    ]);
    failure = undefined;
    expect((await a.sync()).stuck).toEqual([]);
  });

  it("ignores an unreadable persisted value", async () => {
    const clock = new ManualClock(T0);
    const state = memoryGateState();
    state.stuck = "{not json";
    const a = await open(A, [new MemoryTransport()], clock, { gateState: state });
    expect((await a.sync()).stuck).toEqual([]);
    state.stuck = JSON.stringify([{ device: "x", seg: 1 }]);
    const b = await open(A, [new MemoryTransport()], clock, { gateState: state });
    expect((await b.sync()).stuck).toEqual([]);
  });
});
