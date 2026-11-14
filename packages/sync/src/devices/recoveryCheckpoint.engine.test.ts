// The engine's verified-prefix checkpoint (`recoveryCheckpoint`, the phone's open strategy) over the real
// device gate, codec and signatures. Oracles: the number of frames the codec opens (counted by a wrapper),
// and the result and view of the same recovery WITHOUT a checkpoint (the behaviour the hosts keep), run
// on copies of the log, view, gate snapshot, evidence and clock taken BEFORE the run it checks, so the
// two runs share no mutable state. Synthetic data only.
import { describe, expect, it } from "vitest";
import type {
  ClockStore,
  EventSink,
  FrameCodec,
  GateStateStore,
  InboundBatch,
  RecoveryCheckpointStore,
  RecoveryProgress,
  Transport,
} from "../carrier.js";
import { createOwnLogCodec } from "../carriers/ownlog/codec.js";
import { bindEd25519Verifier, nobleEd25519Verifier } from "../crypto/ed25519.js";
import {
  certifyDevice,
  createDeviceIdentity,
  createRecoveryKey,
  createVaultWithRecovery,
  recoveryIdentity,
  verifyContextSignature,
} from "../crypto/index.js";
import { createSyncEngine, SYNC_RULES_VERSION } from "../engine.js";
import { formatHlc, type HlcState } from "../hlc.js";
import { encodePayload, frameBytes, scanFrames } from "../segment.js";
import { newEid, sodium } from "../testing/devices/testkit.js";
import { ManualClock, MemorySink } from "../testing/index.js";
import { MemoryClockStore, MemoryTransport } from "../testing/memory.js";
import { concat, lp, toHex, utf8 } from "./bytes.js";
import {
  buildDeviceAdded,
  buildDeviceRevoked,
  buildLeaseClaim,
  buildLeaseRenewal,
} from "./events.js";
import { DeviceFrameGate } from "./gate.js";
import { MemoryProvenanceStore } from "./provenance.js";
import { VaultDevices } from "./vaultDevices.js";

const T0 = Date.UTC(2026, 10, 1, 12);

function offline(): Transport {
  const fail = (): never => {
    throw new Error("recovery touched a remote");
  };
  return { consistency: { kind: "linearizable" }, list: fail, read: fail, append: fail };
}

/**
 * A view that, like the real store, knows the statement types (MemorySink parks events without a gid,
 * which would read as `needsUpgrade` and keep any checkpoint from being written).
 */
class ViewSink extends MemorySink {
  /** Every committed batch, so a copy can be made (`clone`). */
  readonly #history: InboundBatch[] = [];

  override applyBatches(batches: readonly InboundBatch[]) {
    const kept = batches.map((b) => ({
      ...b,
      events: b.events.filter((e) => e.t === "test.set"),
    }));
    const out = super.applyBatches(kept);
    this.#history.push(...kept);
    return out;
  }

  /** An independent view in the same state (same batches applied, in order). */
  clone(): ViewSink {
    const copy = new ViewSink();
    if (this.#history.length > 0) copy.applyBatches(this.#history);
    return copy;
  }
}
const newSink = () => new ViewSink();

const event = (value: string) => ({
  t: "test.set",
  v: 1,
  i: newEid(),
  g: value,
  d: { value },
});

function fixture() {
  const recovery = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
  const identity = createDeviceIdentity(sodium);
  const vault = createVaultWithRecovery(sodium, recovery, identity);
  const vaultId = vault.ring.vaultId;
  const certificate = certifyDevice(
    sodium,
    recovery,
    {
      deviceId: identity.deviceId,
      signPublicKey: identity.signPublicKey,
      boxPublicKey: identity.box.publicKey,
    },
    vaultId,
  );
  const local = new MemoryTransport();
  const sink = newSink();
  const clockStore = new MemoryClockStore();
  let snapshot: string | undefined;
  const evidence: string[] = [];
  const gateState: GateStateStore = {
    load: () => snapshot,
    save: (state) => {
      snapshot = state;
    },
    loadEvidence: () => [...evidence],
    appendEvidence: (records) => {
      evidence.push(...records);
    },
  };
  const cp = { text: undefined as string | undefined, saves: 0, clears: 0, binding: "ring-1" };
  const store: RecoveryCheckpointStore = {
    load: () => cp.text,
    save: (text) => {
      cp.text = text;
      cp.saves += 1;
    },
    clear: () => {
      cp.text = undefined;
      cp.clears += 1;
    },
  };
  let opens = 0;
  const open = async (
    options: {
      checkpoint?: boolean;
      sink?: EventSink;
      local?: Transport;
      gateState?: GateStateStore;
      clockStore?: ClockStore;
      store?: RecoveryCheckpointStore;
      yieldToHost?: { run: () => Promise<void>; now: () => number; sliceMs: number };
      onRecoveryProgress?: (p: RecoveryProgress) => void;
    } = {},
  ) => {
    const ring = vault.ring.clone(sodium);
    const devices = new VaultDevices({
      sodium,
      identity,
      ring,
      provenance: new MemoryProvenanceStore(),
      clock: () => T0,
      bootstrapCertificates: [certificate],
    });
    const real = createOwnLogCodec({ sodium, ring, signer: identity });
    const codec: FrameCodec = {
      ...real,
      open: (sealed, at, prev) => {
        opens += 1;
        return real.open(sealed, at, prev);
      },
    };
    const engine = await createSyncEngine({
      vault: vaultId,
      device: identity.deviceId,
      local: options.local ?? local,
      remotes: [offline()],
      codec,
      gate: new DeviceFrameGate(devices, { sodium }),
      sink: options.sink ?? sink,
      clockStore: options.clockStore ?? clockStore,
      gateState: options.gateState ?? gateState,
      physicalClock: new ManualClock(T0),
      ...(options.checkpoint === false
        ? {}
        : {
            recoveryCheckpoint: {
              store: options.store ?? store,
              binding: () => cp.binding,
              sign: (body: Uint8Array) => identity.sign("cashu/checkpoint/v1", body),
              verify: (body: Uint8Array, sig: Uint8Array) =>
                verifyContextSignature("cashu/checkpoint/v1", body, sig, identity.signPublicKey),
            },
          }),
      ...(options.yieldToHost ? { yieldToHost: options.yieldToHost } : {}),
      ...(options.onRecoveryProgress ? { onRecoveryProgress: options.onRecoveryProgress } : {}),
    });
    return engine;
  };
  /** Frames the codec opens during `fn` (signature verifies counted through the port too). */
  const counted = async <T>(fn: () => Promise<T>) => {
    let verifies = 0;
    const previous = bindEd25519Verifier({
      kind: "noble",
      verify: (s, m, p) => {
        verifies += 1;
        return nobleEd25519Verifier.verify(s, m, p);
      },
    });
    const before = opens;
    try {
      const value = await fn();
      return { value, opens: opens - before, verifies };
    } finally {
      bindEd25519Verifier(previous);
    }
  };
  const intro = () =>
    buildDeviceAdded(
      identity,
      vaultId,
      newEid(),
      {
        deviceId: identity.deviceId,
        signPublicKey: identity.signPublicKey,
        boxPublicKey: identity.box.publicKey,
      },
      "device",
      certificate,
    );
  /** A device of the vault writing into the same local log (as a pulled stream would land). */
  const writer = async () => {
    const other = createDeviceIdentity(sodium);
    const subject = {
      deviceId: other.deviceId,
      signPublicKey: other.signPublicKey,
      boxPublicKey: other.box.publicKey,
    };
    const cert = certifyDevice(sodium, recovery, subject, vaultId);
    const ring = vault.ring.clone(sodium);
    const engine = await createSyncEngine({
      vault: vaultId,
      device: other.deviceId,
      local,
      codec: createOwnLogCodec({ sodium, ring, signer: other }),
      gate: new DeviceFrameGate(
        new VaultDevices({
          sodium,
          identity: other,
          ring,
          provenance: new MemoryProvenanceStore(),
          clock: () => T0,
          bootstrapCertificates: [cert],
        }),
        { sodium },
      ),
      sink: newSink(),
      clockStore: new MemoryClockStore(),
      physicalClock: new ManualClock(T0),
    });
    const admission = buildDeviceAdded(recovery, vaultId, newEid(), subject, "second", cert);
    return { identity: other, engine, admission };
  };
  /** Append one frame signed by this device straight to the local log (a frame no engine wrote). */
  const appendOwn = async (events: readonly ReturnType<typeof event>[], counter: number) => {
    const codec = createOwnLogCodec({ sodium, ring: vault.ring.clone(sodium), signer: identity });
    const device = identity.deviceId;
    const bytes = await local.read(vaultId, device, 1, 0);
    let prev = codec.genesis(vaultId, device, 1);
    for (const frame of scanFrames(bytes, 0).frames) {
      prev = codec.link(
        frame.sealed,
        { vault: vaultId, device, seg: 1, offset: frame.offset },
        prev,
      );
    }
    const plain = encodePayload({
      events: events.map((e, i) => ({
        ...e,
        h: formatHlc({ wall: T0, counter: counter + i, device }),
      })),
    });
    const sealed = await codec.seal(
      plain,
      { vault: vaultId, device, seg: 1, offset: bytes.length },
      prev,
    );
    await local.append(vaultId, device, 1, bytes.length, frameBytes(sealed.sealed));
    clockStore.save({ wall: T0, counter: counter + events.length });
  };
  /** Copies of the log, view, gate snapshot, evidence and clock as they are now (the oracle's input). */
  const capture = async (
    options: { local?: MemoryTransport; sink?: ViewSink } = {},
  ): Promise<Captured> => ({
    log: await copyLog(options.local ?? local, vaultId),
    sink: (options.sink ?? sink).clone(),
    snapshot,
    evidence: [...evidence],
    clock: clockStore.load(),
  });
  /** Re-signs the stored checkpoint after `edit` changed its body (what only this device's key can do). */
  const resign = (edit: (body: Record<string, unknown>) => void) => {
    const outer = JSON.parse(cp.text ?? "{}") as { body: string; sig: string };
    const body = JSON.parse(outer.body) as Record<string, unknown>;
    edit(body);
    const text = JSON.stringify(body);
    cp.text = JSON.stringify({
      body: text,
      sig: toHex(identity.sign("cashu/checkpoint/v1", utf8(text))),
    });
  };
  /** Re-signs a gate state text (`cashu/state/v1`, gateState.ts) after `edit` changed its JSON. */
  const resignGate = (state: string, edit: (json: Record<string, unknown>) => void) => {
    const json = JSON.parse(state.slice(0, state.lastIndexOf("\n"))) as Record<string, unknown>;
    edit(json);
    const text = JSON.stringify(json);
    const body = concat(lp(utf8(vaultId)), lp(utf8(identity.deviceId)), utf8(text));
    return `${text}\n${toHex(identity.sign("cashu/state/v1", body))}`;
  };
  return {
    capture,
    resign,
    resignGate,
    /** The view lost its gate snapshot (no anchors): only the checkpoint's own checks remain. */
    dropSnapshot: () => {
      snapshot = undefined;
    },
    identity,
    recovery,
    vaultId,
    local,
    sink,
    cp,
    store,
    evidence,
    open,
    counted,
    intro,
    writer,
    appendOwn,
  };
}

type Fixture = ReturnType<typeof fixture>;

interface Captured {
  readonly log: MemoryTransport;
  readonly sink: ViewSink;
  readonly snapshot: string | undefined;
  readonly evidence: readonly string[];
  readonly clock: HlcState | undefined;
}

/** A log of the intro plus `n` one-event frames, recovered once (which writes the checkpoint). */
async function seeded(n: number): Promise<Fixture> {
  const f = fixture();
  const engine = await f.open();
  await engine.write([f.intro()]);
  for (let i = 0; i < n; i++) await engine.write([event(`v${i}`)]);
  const first = await f.counted(() => engine.recoverLocal());
  expect(first.value.complete).toBe(true);
  expect(first.opens).toBe(n + 1);
  expect(f.cp.text).toBeDefined();
  await engine.close();
  return f;
}

/**
 * The same recovery without a checkpoint over a captured state (the oracle): its own log, view, gate
 * snapshot, evidence and clock, none of which the checked run can reach.
 */
async function reference(f: Fixture, captured: Captured) {
  let snapshot = captured.snapshot;
  const evidence = [...captured.evidence];
  const gateState: GateStateStore = {
    load: () => snapshot,
    save: (state) => {
      snapshot = state;
    },
    loadEvidence: () => [...evidence],
    appendEvidence: (records) => {
      evidence.push(...records);
    },
  };
  const sink = captured.sink.clone();
  const engine = await f.open({
    checkpoint: false,
    sink,
    local: await copyLog(captured.log, f.vaultId),
    gateState,
    clockStore: new MemoryClockStore(captured.clock),
  });
  const result = await engine.recoverLocal();
  await engine.close();
  return { result, sink };
}

function copyLog(source: MemoryTransport, vault: string): Promise<MemoryTransport> {
  return (async () => {
    const out = new MemoryTransport();
    for (const s of await source.list(vault)) {
      await out.append(vault, s.device, s.seg, 0, await source.read(vault, s.device, s.seg, 0));
    }
    return out;
  })();
}

describe("recovery checkpoint (phone open strategy)", () => {
  it("an open after a checkpoint opens no frame; a kill after appends verifies only those", async () => {
    const f = await seeded(20);
    const again = await f.open();
    const quiet = await f.counted(() => again.recoverLocal());
    expect(quiet.value.complete).toBe(true);
    expect(quiet.opens).toBe(0);
    // The checkpoint's own signature and the gate state's signed heads, not one per frame.
    expect(quiet.verifies).toBeLessThan(6);
    // Three commands land in the log, then the app dies before any recovery wrote a checkpoint.
    for (let i = 0; i < 3; i++) await again.write([event(`late${i}`)]);
    const savesBefore = f.cp.saves;
    // (no close: a kill)
    const before = await f.capture();
    const reopened = await f.open();
    const tail = await f.counted(() => reopened.recoverLocal());
    expect(tail.opens).toBe(3);
    expect(f.cp.saves).toBe(savesBefore + 1);
    const oracle = await reference(f, before);
    expect(tail.value).toEqual(oracle.result);
    for (const v of ["v0", "v19", "late0", "late2"]) expect(f.sink.value(v)).toBe(v);
    expect(oracle.sink.value("late2")).toBe("late2");
    await reopened.close();
  });

  it("after a pass-like append of a known writer's frames, only those frames are verified", async () => {
    const f = fixture();
    const engine = await f.open();
    const b = await f.writer();
    await engine.write([f.intro(), b.admission]);
    expect((await engine.recoverLocal()).complete).toBe(true);
    for (let i = 0; i < 4; i++) await b.engine.write([event(`b${i}`)]);
    await b.engine.close();
    const before = await f.capture();
    const pass = await f.counted(() => engine.recoverLocal());
    expect(pass.value.complete).toBe(true);
    expect(pass.opens).toBe(4);
    expect(f.sink.value("b3")).toBe("b3");
    expect(pass.value).toEqual((await reference(f, before)).result);
    await engine.close();
  });

  it.each([
    ["another vault's checkpoint", "foreign"],
    ["a checkpoint with a changed body", "forged"],
    ["a different key ring (rotation)", "binding"],
    ["a view rolled back to empty", "view"],
    ["a fork proof recorded after it", "evidence"],
  ] as const)("discards %s and replays every frame to the same state", async (_name, fault) => {
    const f = await seeded(8);
    let sink: ViewSink | undefined;
    if (fault === "foreign") {
      const g = await seeded(2);
      f.cp.text = g.cp.text;
    } else if (fault === "forged") {
      const outer = JSON.parse(f.cp.text ?? "{}") as { body: string; sig: string };
      // A change the decoder accepts and that would skip nothing new: only the signature refuses it.
      f.cp.text = JSON.stringify({
        ...outer,
        body: outer.body.replace('"suppressed":false', '"suppressed":true'),
      });
      expect(f.cp.text).toContain('\\"suppressed\\":true');
    } else if (fault === "binding") {
      f.cp.binding = "ring-2";
    } else if (fault === "view") {
      sink = newSink();
    } else {
      f.evidence.push("synthetic-record");
    }
    const before = await f.capture(sink ? { sink } : {});
    const engine = await f.open(sink ? { sink } : {});
    const run = await f.counted(() => engine.recoverLocal());
    expect(run.opens).toBe(9);
    const oracle = await reference(f, before);
    expect(run.value).toEqual(oracle.result);
    expect(run.value.complete).toBe(true);
    if (sink) expect(sink.value("v7")).toBe("v7");
    // A fresh checkpoint replaces the doubtful one: the next open opens nothing.
    expect(f.cp.text).toBeDefined();
    const reopened = await f.open(sink ? { sink } : {});
    const next = await f.counted(() => reopened.recoverLocal());
    expect(next.opens).toBe(0);
    await engine.close();
  });

  it.each(["body", "signature"] as const)(
    "without view anchors, its own chain and signature digest catch a rewritten frame %s",
    async (what) => {
      const f = await seeded(4);
      f.dropSnapshot();
      const bytes = (await f.local.read(f.vaultId, f.identity.deviceId, 1, 0)).slice();
      const frame = scanFrames(bytes, 0).frames[2];
      if (!frame) throw new Error("no frame");
      // The chain covers the frame without its trailing signature; the digest covers the signature.
      const at = what === "body" ? Math.floor((frame.offset + frame.end) / 2) : frame.end - 5;
      bytes[at] = (bytes[at] ?? 0) ^ 1;
      const log = new MemoryTransport();
      await log.append(f.vaultId, f.identity.deviceId, 1, 0, bytes);
      // The same view (its cursor is the checkpoint's): only the prefix bytes differ.
      const before = await f.capture({ local: log });
      const engine = await f.open({ local: log });
      const run = await f.counted(() => engine.recoverLocal());
      expect(run.opens).toBeGreaterThanOrEqual(3);
      expect(run.value.complete).toBe(false);
      expect(run.value.streams[0]?.disposition).toBe("unresolved_tail");
      expect(run.value).toEqual((await reference(f, before)).result);
    },
  );

  it("discards it for a truncated log: the full replay reports what a replay without it reports", async () => {
    const f = await seeded(6);
    const listed = await f.local.list(f.vaultId);
    const own = listed.find((s) => s.device === f.identity.deviceId);
    if (!own) throw new Error("no own segment");
    const bytes = await f.local.read(f.vaultId, own.device, 1, 0);
    const frames = scanFrames(bytes, 0).frames;
    const cut = frames[4]?.end ?? 0;
    const truncated = new MemoryTransport();
    await truncated.append(f.vaultId, own.device, 1, 0, bytes.subarray(0, cut));
    const fresh = newSink();
    const before = await f.capture({ local: truncated, sink: fresh });
    const engine = await f.open({ local: truncated, sink: fresh });
    const run = await f.counted(() => engine.recoverLocal());
    expect(run.opens).toBe(5);
    expect(run.value).toEqual((await reference(f, before)).result);
    expect(run.value.complete).toBe(false);
    expect(f.cp.text).toBeUndefined();
  });

  it("falls back to the full replay for a tail that admits a writer, and converges", async () => {
    const f = await seeded(5);
    const b = await f.writer();
    await b.engine.write([event("b0")]);
    await b.engine.close();
    await f.appendOwn([b.admission as unknown as ReturnType<typeof event>], 100);
    const before = await f.capture();
    const engine = await f.open();
    const run = await f.counted(() => engine.recoverLocal());
    // The admitting tail is not trusted against the prefix: every frame is opened again.
    expect(run.opens).toBeGreaterThanOrEqual(8);
    expect(run.value.complete).toBe(true);
    const oracle = await reference(f, before);
    expect(run.value).toEqual(oracle.result);
    expect(oracle.sink.value("b0")).toBe("b0");
    expect(f.sink.value("b0")).toBe("b0");
    const reopened = await f.open();
    const next = await f.counted(() => reopened.recoverLocal());
    expect(next.opens).toBe(0);
    await engine.close();
  });

  it("a revocation in the tail gives the full replay's verdict on the stale view", async () => {
    const f = fixture();
    const a = await f.open();
    const b = await f.writer();
    await a.write([f.intro(), b.admission]);
    await b.engine.write([event("before")]);
    const firstEnd =
      (await f.local.list(f.vaultId)).find((s) => s.device === b.identity.deviceId)?.size ?? 0;
    await b.engine.write([event("after")]);
    await b.engine.close();
    expect((await a.recoverLocal()).complete).toBe(true);
    expect(f.cp.text).toBeDefined();
    expect(f.sink.value("after")).toBe("after");
    await a.close();
    const revocation = buildDeviceRevoked(f.recovery, f.vaultId, newEid(), [
      { device: b.identity.deviceId, cut: { seg: 1, offset: firstEnd } },
    ]);
    await f.appendOwn([revocation as unknown as ReturnType<typeof event>], 50);
    const before = await f.capture();
    const withCheckpoint = await f.open();
    const result = await withCheckpoint.recoverLocal();
    const oracle = (await reference(f, before)).result;
    expect(result).toEqual(oracle);
    expect(result.complete).toBe(false);
    expect(result.requiresViewRebuild).toBe(true);
    expect(result.streams.find((s) => s.device === b.identity.deviceId)?.reason).toBe(
      "cursor-not-accepted",
    );
    expect(f.cp.text).toBeUndefined();
  });

  it("an incomplete recovery clears it; a missing store row replays everything", async () => {
    const f = await seeded(3);
    const own = (await f.local.list(f.vaultId)).find((s) => s.device === f.identity.deviceId);
    await f.local.append(f.vaultId, f.identity.deviceId, 1, own?.size ?? 0, new Uint8Array([0, 0]));
    const before = await f.capture();
    const engine = await f.open();
    const run = await f.counted(() => engine.recoverLocal());
    expect(run.value.complete).toBe(false);
    expect(run.value.streams[0]?.reason).toBe("partial");
    expect(f.cp.text).toBeUndefined();
    expect(run.value).toEqual((await reference(f, before)).result);
  });

  it("yields to the host between slices and reports progress", async () => {
    const f = await seeded(12);
    f.cp.text = undefined;
    const before = await f.capture();
    let tick = 0;
    let runs = 0;
    const progress: RecoveryProgress[] = [];
    const engine = await f.open({
      yieldToHost: {
        run: async () => {
          runs += 1;
        },
        now: () => {
          tick += 3;
          return tick;
        },
        sliceMs: 8,
      },
      onRecoveryProgress: (p) => progress.push(p),
    });
    runs = 0;
    const result = await engine.recoverLocal();
    expect(result.complete).toBe(true);
    expect(runs).toBeGreaterThan(3);
    expect(progress.at(-1)).toEqual({ done: 13, total: 13 });
    expect(progress.length).toBeGreaterThan(1);
    expect(result).toEqual((await reference(f, before)).result);
  });

  it.each([
    ["is used under the same rules version (control: the re-signed row is sound)", 0, 0],
    ["is discarded under the next rules version", 1, 9],
    ["is discarded under the previous rules version", -1, 9],
  ] as const)("a re-signed checkpoint %s", async (_name, delta, opens) => {
    const f = await seeded(8);
    expect(f.cp.text).toContain(`\\"rules\\":${SYNC_RULES_VERSION}`);
    f.resign((body) => {
      body.rules = SYNC_RULES_VERSION + delta;
    });
    const before = await f.capture();
    const engine = await f.open();
    const run = await f.counted(() => engine.recoverLocal());
    expect(run.opens).toBe(opens);
    expect(run.value.complete).toBe(true);
    expect(run.value).toEqual((await reference(f, before)).result);
    // The row now carries the running code's version: the next open opens nothing.
    expect(f.cp.text).toContain(`\\"rules\\":${SYNC_RULES_VERSION}`);
    const reopened = await f.open();
    expect((await f.counted(() => reopened.recoverLocal())).opens).toBe(0);
    await engine.close();
  });

  it("binds the evidence record by content: a swapped record of the same count is discarded", async () => {
    const f = fixture();
    f.evidence.push("synthetic-record-a");
    const engine = await f.open();
    await engine.write([f.intro()]);
    for (let i = 0; i < 3; i++) await engine.write([event(`v${i}`)]);
    expect((await engine.recoverLocal()).complete).toBe(true);
    expect(f.cp.text).toBeDefined();
    await engine.close();
    // Control: the unchanged record keeps the checkpoint.
    const quiet = await f.open();
    expect((await f.counted(() => quiet.recoverLocal())).opens).toBe(0);
    await quiet.close();
    f.evidence[0] = "synthetic-record-b";
    const before = await f.capture();
    const swapped = await f.open();
    const run = await f.counted(() => swapped.recoverLocal());
    expect(run.opens).toBe(4);
    expect(run.value).toEqual((await reference(f, before)).result);
    await swapped.close();
  });

  it("keeps it for a tail of lease statements only, verifying just the tail", async () => {
    const f = await seeded(4);
    const engine = await f.open();
    const claim = buildLeaseClaim(f.identity, f.vaultId, newEid(), {
      at: T0,
      until: T0 + 60 * 60 * 1000,
      watermark: {},
      prev: null,
    });
    await engine.write([claim]);
    await engine.write([
      buildLeaseRenewal(f.identity, f.vaultId, newEid(), {
        at: T0 + 1000,
        until: T0 + 2 * 60 * 60 * 1000,
        watermark: {},
        prev: claim.i,
      }),
    ]);
    // (no close: a kill before any recovery)
    const savesBefore = f.cp.saves;
    const clearsBefore = f.cp.clears;
    const before = await f.capture();
    const reopened = await f.open();
    const run = await f.counted(() => reopened.recoverLocal());
    expect(run.opens).toBe(2);
    expect(run.value.complete).toBe(true);
    expect(f.cp.clears).toBe(clearsBefore);
    expect(f.cp.saves).toBe(savesBefore + 1);
    expect(run.value).toEqual((await reference(f, before)).result);
    const next = await f.open();
    expect((await f.counted(() => next.recoverLocal())).opens).toBe(0);
    await reopened.close();
  });

  it("falls back when the restored accepted range is refused under the current fold", async () => {
    // The state an older build could have signed: B's data accepted past a revocation cut that the
    // statements in the same checkpoint carry. The current fold of those statements refuses it.
    const f = fixture();
    const a = await f.open();
    const b = await f.writer();
    await a.write([f.intro(), b.admission]);
    await b.engine.write([event("before")]);
    const firstEnd =
      (await f.local.list(f.vaultId)).find((s) => s.device === b.identity.deviceId)?.size ?? 0;
    await b.engine.write([event("after")]);
    await b.engine.close();
    expect((await a.recoverLocal()).complete).toBe(true);
    const lax = JSON.parse(f.cp.text ?? "{}") as { body: string };
    const laxGate = (JSON.parse(lax.body) as { gate: string }).gate;
    await a.close();
    await f.appendOwn(
      [
        buildDeviceRevoked(f.recovery, f.vaultId, newEid(), [
          { device: b.identity.deviceId, cut: { seg: 1, offset: firstEnd } },
        ]) as unknown as ReturnType<typeof event>,
      ],
      50,
    );
    // The old view (B applied through "after"); then a rebuilt one, which writes a sound checkpoint.
    const stale = await f.open();
    expect((await stale.recoverLocal()).requiresViewRebuild).toBe(true);
    await stale.close();
    expect(f.sink.value("after")).toBe("after");
    f.dropSnapshot();
    const rebuilt = newSink();
    const fresh = await f.open({ sink: rebuilt });
    expect((await fresh.recoverLocal()).complete).toBe(true);
    await fresh.close();
    expect(rebuilt.value("after")).toBeUndefined();
    const oldCursors = f.sink.cursors();
    const B = b.identity.deviceId;
    const json = (state: string) =>
      JSON.parse(state.slice(0, state.lastIndexOf("\n"))) as {
        applied: [string, number, number][];
        heads: [string, unknown][];
      };
    const oldGate = json(laxGate);
    f.resign((body) => {
      body.gate = f.resignGate(body.gate as string, (g) => {
        const gate = g as unknown as ReturnType<typeof json>;
        gate.applied = [
          ...gate.applied.filter(([d]) => d !== B),
          ...oldGate.applied.filter(([d]) => d === B),
        ];
        const known = new Set(gate.heads.map((h) => JSON.stringify(h)));
        gate.heads = [...gate.heads, ...oldGate.heads.filter((h) => !known.has(JSON.stringify(h)))];
      });
      for (const stream of body.streams as { device: string; cursor: unknown }[]) {
        const cursor = oldCursors.get(stream.device);
        if (cursor) stream.cursor = { seg: cursor.seg, offset: cursor.offset };
      }
    });
    const before = await f.capture();
    const engine = await f.open();
    const run = await f.counted(() => engine.recoverLocal());
    // Every frame opened again: A's two, B's two.
    expect(run.opens).toBe(4);
    const oracle = await reference(f, before);
    expect(run.value).toEqual(oracle.result);
    expect(run.value.complete).toBe(false);
    expect(run.value.requiresViewRebuild).toBe(true);
    expect(run.value.streams.find((s) => s.device === B)?.reason).toBe("cursor-not-accepted");
    await engine.close();
  });
});
