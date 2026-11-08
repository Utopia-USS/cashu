// Multi-device simulation for the devices tests (synthetic data only). Not exported from the package.
//
// Each simulated device holds its own identity, ring, `VaultDevices` state, HLC clock (with its own
// skew against the simulated true time) and its own append-only stream of batches. One batch is one
// frame here: its "bytes" are its canonical content, and it carries its writer's signed head over
// the writer's hash chain (crypto head.ts, S29c phase B2). A shared remote keeps every pushed batch
// (and lets a test rewrite one, as untrusted storage can).
//
// A device models the engine + gate contract (carrier.ts `FrameGate`, devices/gate.ts): it downloads
// batches in per-device order, recomputes each batch's chain from the previous batch IT holds,
// verifies the head through the gate (a forged, rewritten or reordered batch stops that stream; a
// writer not known yet waits), passes the statements of every verified batch to the gate (also
// batches whose data is rejected), and applies a batch's data only through the guard: per writer,
// the accepted data is the longest prefix that passes `guard.check`. When the gate reports data no
// longer accepted, the device rebuilds its data view (lead decision D8).

import type { LeaseTransport, SegmentCursor, UnstampedEvent } from "../../carrier.js";
import { START_CURSOR } from "../../carrier.js";
import {
  CertificateCache,
  createDeviceIdentity,
  createRecoveryKey,
  createVaultWithRecovery,
  type DeviceIdentity,
  frameDigest,
  genesisChain,
  headBody,
  type Keyring,
  loadNodeSodium,
  nextChain,
  type RecoveryIdentity,
  recoveryIdentity,
  type SignedHead,
  type Sodium,
  signHead,
} from "../../crypto/index.js";
import {
  buildDeviceAdded,
  buildDeviceRevoked,
  consentToRevocation,
  type LogEvent,
  pinConfirmationText,
  type RevokedEntry,
} from "../../devices/events.js";
import { DeviceFrameGate } from "../../devices/gate.js";
import type { FrameRejection } from "../../devices/guard.js";
import {
  creatorPin,
  type LeaseLocal,
  type OwnLeaseRecord,
  pinEventFor,
} from "../../devices/lease.js";
import { PairingInviter, PairingJoiner } from "../../devices/pairing.js";
import { type PairingLink, runInviter, runJoiner } from "../../devices/pairingLink.js";
import { comparePositions } from "../../devices/positions.js";
import { MemoryProvenanceStore } from "../../devices/provenance.js";
import {
  acknowledgeRevocationPreview,
  previewRevocation,
  type RevocationPreviewRequest,
} from "../../devices/revocationPolicy.js";
import { recordPairingProvenance } from "../../devices/rotation.js";
import { memoizedVerifier, type StatementVerifier } from "../../devices/statements.js";
import { VaultDevices } from "../../devices/vaultDevices.js";
import { formatHlc, type Hlc, HybridClock, parseHlc } from "../../hlc.js";

export const sodium: Sodium = await loadNodeSodium();

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let eidCounter = 0;

/** A fresh, increasing ULID-shaped eid. */
export function newEid(): string {
  let n = ++eidCounter;
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

export function hlcAt(deviceId: string, wall: number, counter = 0): Hlc {
  return formatHlc({ wall, counter, device: deviceId });
}

export const START_TIME = Date.UTC(2026, 9, 31, 12, 0, 0);
const MAX_SKEW = 5 * 60 * 1000;

export interface Batch {
  readonly device: string;
  readonly events: readonly LogEvent[];
  /** Start of the batch's frame (frame AAD offset) and the cursor after it. */
  readonly start: SegmentCursor;
  readonly cursor: SegmentCursor;
  /** The writer's signed head (its chain as the writer computed it; readers recompute theirs). */
  readonly head: SignedHead;
}

/** The bytes a batch's digest covers (its "frame"): writer, positions and events. */
function batchBytes(b: Pick<Batch, "device" | "start" | "cursor" | "events">): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      b.device,
      b.start,
      b.cursor,
      b.events.map((e) => [e.eid, e.hlc, e.type, e.v, e.data]),
    ]),
  );
}

/** The chain after `b` when the stream before it ends with `prev`. */
export function chainOf(
  vaultId: string,
  b: Pick<Batch, "device" | "start" | "cursor" | "events">,
  prev: Uint8Array,
): Uint8Array {
  return nextChain(
    { vaultId, deviceId: b.device, stream: 1 },
    { seg: b.start.seg, start: b.start.offset, end: b.cursor.offset },
    prev,
    frameDigest(batchBytes(b)),
  );
}

/**
 * A batch at `start`..`cursor` of `writer`'s stream whose head is signed by `signer`'s key, whoever
 * that is (a forgery when it is not the writer: a revoked device or untrusted storage).
 */
export function forgeBatch(
  vaultId: string,
  signer: DeviceIdentity,
  writer: string,
  at: { readonly start: SegmentCursor; readonly cursor: SegmentCursor },
  events: readonly LogEvent[],
  prev: Uint8Array,
): Batch {
  const content = { device: writer, start: at.start, cursor: at.cursor, events };
  const unsigned = {
    device: writer,
    stream: 1 as const,
    seg: at.cursor.seg,
    offset: at.cursor.offset,
    chain: chainOf(vaultId, content, prev),
  };
  const head = { ...unsigned, sig: signer.sign("cashu/head/v1", headBody(vaultId, unsigned)) };
  return { ...content, head };
}

/**
 * How a simulated remote shows a published batch to OTHER devices (S29c R4): at once
 * (`linearizable`), within `maxDelayMs` (`bounded`, a relay that keeps its declared bound), or after
 * any delay up to `maxDelayMs` with a share of batches held back until `flush()` (`eventual`, a
 * synced folder: no bound is declared). Delays are drawn per reader and batch from a seeded PRNG;
 * a later batch of a stream is never visible before an earlier one.
 */
export type SimVisibility =
  | { readonly kind: "linearizable" }
  | { readonly kind: "bounded"; readonly maxDelayMs: number }
  | { readonly kind: "eventual"; readonly maxDelayMs: number; readonly stallRate?: number };

export class SimRemote {
  readonly batches = new Map<string, Batch[]>();
  readonly visibility: SimVisibility;
  /** Simulated true time, ms. */
  time = START_TIME;
  readonly #publishedAt = new Map<Batch, number>();
  readonly #visibleAt = new Map<string, number>();
  readonly #rand: () => number;
  #flushed = false;

  constructor(options: { visibility?: SimVisibility; seed?: number } = {}) {
    this.visibility = options.visibility ?? { kind: "linearizable" };
    this.#rand = mulberry32(options.seed ?? 1);
  }

  publish(batch: Batch): void {
    const list = this.batches.get(batch.device) ?? [];
    if (!list.some((b) => b.cursor.offset === batch.cursor.offset)) {
      list.push(batch);
      this.#publishedAt.set(batch, this.time);
    }
    list.sort((x, y) => comparePositions(x.cursor, y.cursor));
    this.batches.set(batch.device, list);
  }

  /** Every published batch becomes visible to every reader (the "eventually") until `unflush`. */
  flush(): void {
    this.#flushed = true;
  }

  /** Back to the visibility model for what is published from now on (earlier batches stay seen). */
  unflush(): void {
    for (const list of this.batches.values()) for (const b of list) this.#publishedAt.delete(b);
    this.#flushed = false;
  }

  /** Whether `reader` sees `batch` now (its own batches and replaced ones always). */
  visibleTo(reader: string, batch: Batch): boolean {
    return this.#flushed || this.#visibleAtFor(reader, batch) <= this.time;
  }

  /** What the remote's transport declares, as the engine would report it after a pass. */
  report(lastPullAt: number | undefined, lastPushAt: number | undefined): LeaseTransport {
    const v = this.visibility;
    if (v.kind === "eventual" || lastPullAt === undefined) return { kind: "eventual" };
    return {
      kind: "bounded",
      propagationMs: v.kind === "bounded" ? v.maxDelayMs : 0,
      lastPullAt,
      lastPushAt: lastPushAt ?? lastPullAt,
    };
  }

  #visibleAtFor(reader: string, batch: Batch): number {
    const published = this.#publishedAt.get(batch);
    if (published === undefined || reader === batch.device) return Number.NEGATIVE_INFINITY;
    const key = `${reader}|${batch.device}|${batch.cursor.offset}`;
    const known = this.#visibleAt.get(key);
    if (known !== undefined) return known;
    const v = this.visibility;
    let at = published;
    if (v.kind !== "linearizable") {
      const stalled = v.kind === "eventual" && this.#rand() < (v.stallRate ?? 0);
      at = stalled
        ? Number.POSITIVE_INFINITY
        : published + Math.floor(this.#rand() * (v.maxDelayMs + 1));
    }
    // Per-stream order: never before the previous batch of the same stream.
    const list = this.batches.get(batch.device) ?? [];
    const i = list.indexOf(batch);
    const before = i > 0 ? (list[i - 1] as Batch) : undefined;
    if (before) at = Math.max(at, this.#visibleAtFor(reader, before));
    this.#visibleAt.set(key, at);
    return at;
  }

  /** Untrusted storage replaces a stored batch (a device rewriting its own frame, review A1b). */
  replace(batch: Batch): void {
    const list = this.batches.get(batch.device) ?? [];
    this.batches.set(
      batch.device,
      list.map((b) => (b.cursor.offset === batch.cursor.offset ? batch : b)),
    );
  }
}

export interface WriteOptions {
  /** Override the HLC of the i-th event (a writer backdating its stamps). */
  readonly hlc?: (i: number) => Hlc;
}

export class SimDevice {
  readonly name: string;
  readonly identity: DeviceIdentity;
  readonly remote: SimRemote;
  readonly provenance = new MemoryProvenanceStore();
  readonly stream: Batch[] = [];
  readonly own = new Map<string, OwnLeaseRecord>();
  /** Data-applied cursor per writer device (the store's view cursors; lease watermarks). */
  readonly cursors = new Map<string, SegmentCursor>();
  /** Every rejection the guard reported on this device. */
  readonly rejections: FrameRejection[] = [];
  /** Signature and certificate caches of this device (shared by pairing and its devices state). */
  readonly verify: StatementVerifier;
  readonly certificateCache: CertificateCache;
  skewMs: number;
  lastPullAt: number | undefined;
  lastPushAt: number | undefined;
  /**
   * Test-only: this device believes its transport is linearizable whatever the remote does (the
   * rule-6 control: an eventual remote treated as bounded must break the property).
   */
  assumeBounded = false;
  /** The vault's recovery words, as the owner knows them (the honest revoke helpers fall back to them). */
  words: RecoveryIdentity | undefined;
  devices!: VaultDevices;
  gate!: DeviceFrameGate;
  #bootstrap: readonly Uint8Array[] = [];
  #clock: HybridClock;
  #pushed = 0;
  #offset = 0;
  /** Downloaded batches per writer, in stream order (verified; statements already ingested). */
  readonly #downloaded = new Map<string, Batch[]>();
  /** The chain after the last downloaded batch per writer (as this device computed it). */
  readonly #heldChains = new Map<string, Uint8Array>();
  /** Every head verdict of a download, in order (tests read why a stream stopped). */
  readonly verdicts: { device: string; cursor: SegmentCursor; verdict: string }[] = [];
  /** Accepted data per writer: the batches whose data is in this device's view. */
  readonly #accepted = new Map<string, Batch[]>();
  /** Peers whose latest events were more than the skew ahead of this clock (HLC warnings). */
  readonly #farAhead = new Map<string, boolean>();

  constructor(
    name: string,
    remote: SimRemote,
    skewMs = 0,
    identity?: DeviceIdentity,
    /** Signature caches seeded by another device (results are a function of the bytes). */
    caches?: { readonly verify: StatementVerifier; readonly certificateCache: CertificateCache },
  ) {
    this.verify = caches?.verify ?? memoizedVerifier();
    this.certificateCache = caches?.certificateCache ?? new CertificateCache();
    this.name = name;
    this.remote = remote;
    this.skewMs = skewMs;
    this.identity = identity ?? createDeviceIdentity(sodium);
    this.#clock = new HybridClock(this.identity.deviceId, {
      physical: { now: () => this.now() },
    });
  }

  get id(): string {
    return this.identity.deviceId;
  }

  get ring(): Keyring {
    return this.devices.ring;
  }

  /** Lease watermark input: the data-applied cursors. */
  get applied(): ReadonlyMap<string, SegmentCursor> {
    return this.cursors;
  }

  /** This device's wall clock. */
  now(): number {
    return this.remote.time + this.skewMs;
  }

  attach(
    ring: Keyring,
    bootstrapCertificates: readonly Uint8Array[],
    recovering?: { highestRecoveryEpoch: number },
  ): void {
    this.#bootstrap = bootstrapCertificates;
    this.devices = new VaultDevices({
      sodium,
      identity: this.identity,
      ring,
      provenance: this.provenance,
      clock: () => this.now(),
      bootstrapCertificates,
      verify: this.verify,
      certificateCache: this.certificateCache,
      ...(recovering ? { recovering } : {}),
    });
    this.gate = new DeviceFrameGate(this.devices, { sodium, verify: this.verify });
  }

  /** Stamps and appends one batch to this device's own stream and applies it. */
  write(events: readonly UnstampedEvent[], options: WriteOptions = {}): Batch {
    const writer = this.id;
    this.#offset += 100;
    const start = { seg: 1, offset: this.#offset - 100 };
    const cursor = { seg: 1, offset: this.#offset };
    const stamped: LogEvent[] = events.map((e, i) => ({
      eid: e.i,
      hlc: options.hlc ? options.hlc(i) : this.#clock.tick(),
      writer,
      position: cursor,
      type: e.t,
      v: e.v,
      data: e.d,
    }));
    const vaultId = this.devices.ring.vaultId;
    const prev =
      this.stream.at(-1)?.head.chain ?? genesisChain({ vaultId, deviceId: writer, stream: 1 });
    const content = { device: writer, events: stamped, start, cursor };
    const head = signHead(this.identity, vaultId, {
      device: writer,
      stream: 1,
      seg: cursor.seg,
      offset: cursor.offset,
      chain: chainOf(vaultId, content, prev),
    });
    const batch: Batch = { ...content, head };
    this.stream.push(batch);
    for (const e of stamped) {
      if (e.type.startsWith("lease.")) this.own.set(e.eid, { writtenAt: this.now() });
    }
    this.#download(batch);
    this.#settle();
    return batch;
  }

  /** Pushes own unpublished batches to the remote. */
  push(): void {
    for (const b of this.stream.slice(this.#pushed)) {
      this.remote.publish(b);
      for (const e of b.events) {
        const rec = this.own.get(e.eid);
        if (rec && rec.publishedAt === undefined)
          this.own.set(e.eid, { ...rec, publishedAt: this.now() });
      }
    }
    this.#pushed = this.stream.length;
    this.lastPushAt = this.now();
  }

  /** Downloads every batch not downloaded yet, in per-device order (`filter` false stops a stream). */
  pull(filter: (b: Batch) => boolean = () => true): void {
    // A stream whose writer is not known yet waits; another stream may register it in the same
    // pull (an inviter's batch carries the certificate), so repeat while that happens (as the
    // engine's rounds do). A stream the filter stopped is not revisited in this pull.
    const stopped = new Set<string>([this.id]);
    for (;;) {
      let progress = false;
      let waited = false;
      for (const device of [...this.remote.batches.keys()].sort()) {
        if (stopped.has(device)) continue;
        const have = this.#downloaded.get(device) ?? [];
        const last = have[have.length - 1]?.cursor;
        for (const b of this.remote.batches.get(device) ?? []) {
          if (last && comparePositions(b.cursor, last) <= 0) continue;
          if (!filter(b) || !this.remote.visibleTo(this.id, b)) {
            stopped.add(device);
            break;
          }
          if (!this.#download(b)) {
            if (this.verdicts.at(-1)?.verdict === "wait") waited = true;
            else stopped.add(device);
            break;
          }
          progress = true;
        }
      }
      if (this.#downloadOwn()) progress = true;
      if (!waited || !progress) break;
    }
    this.#settle();
    this.lastPullAt = this.now();
  }

  /** Re-downloads own batches not held yet (after a rebuild); true when any was taken. */
  #downloadOwn(): boolean {
    const have = this.#downloaded.get(this.id)?.length ?? 0;
    let took = false;
    for (const b of this.stream.slice(have)) {
      if (!this.#download(b)) break;
      took = true;
    }
    return took;
  }

  sync(): void {
    this.push();
    this.pull();
  }

  /** Forgets the view and the devices state and downloads everything again (a store rebuild). */
  rebuild(filter: (b: Batch) => boolean = () => true): void {
    this.#downloaded.clear();
    this.#heldChains.clear();
    this.#accepted.clear();
    this.cursors.clear();
    this.verdicts.length = 0;
    const ring = this.devices.ring;
    this.attach(ring, this.#bootstrap);
    this.#downloadOwn();
    this.pull(filter);
  }

  /**
   * Re-signs this device's own batch `index` with `events`, and every later batch (their chains
   * change): what a device rewriting its own history writes into untrusted storage (review A1b).
   * Returns the new batches; the device's own copy is left as it was.
   */
  rewrite(index: number, events: readonly UnstampedEvent[]): Batch[] {
    const vaultId = this.devices.ring.vaultId;
    let prev =
      index === 0
        ? genesisChain({ vaultId, deviceId: this.id, stream: 1 })
        : (this.stream[index - 1] as Batch).head.chain;
    const out: Batch[] = [];
    for (const [i, original] of this.stream.entries()) {
      if (i < index) continue;
      const stamped =
        i === index
          ? events.map((e, k) => ({
              eid: e.i,
              hlc: original.events[0]?.hlc ?? this.#clock.tick(),
              writer: this.id,
              position: original.cursor,
              type: e.t,
              v: e.v,
              data: e.d,
              ...(k > 0 ? { hlc: this.#clock.tick() } : {}),
            }))
          : original.events;
      const batch = forgeBatch(vaultId, this.identity, this.id, original, stamped, prev);
      out.push(batch);
      prev = batch.head.chain;
    }
    return out;
  }

  /**
   * Verifies `b` against the chain this device holds of its writer and, when its head verifies,
   * keeps it and ingests its statements. False: the stream stops here (retried on the next pull).
   */
  #download(b: Batch): boolean {
    const list = this.#downloaded.get(b.device) ?? [];
    if (this.devices) {
      const vaultId = this.devices.ring.vaultId;
      const prevBatch = list.at(-1);
      const prev = prevBatch
        ? (this.#heldChains.get(b.device) ??
          genesisChain({ vaultId, deviceId: b.device, stream: 1 }))
        : genesisChain({ vaultId, deviceId: b.device, stream: 1 });
      // The reader's own chain, as the codec recomputes it from the bytes it holds.
      const head = { ...b.head, chain: chainOf(vaultId, b, prev) };
      const wire = b.events.map((e) => ({ t: e.type, v: e.v, h: e.hlc, i: e.eid, d: e.data }));
      const verdict = this.gate.authenticate(head, wire);
      this.verdicts.push({
        device: b.device,
        cursor: b.cursor,
        verdict: verdict.ok ? "ok" : verdict.wait ? "wait" : verdict.code,
      });
      if (!verdict.ok) return false;
      this.#heldChains.set(b.device, head.chain);
    }
    list.push(b);
    this.#downloaded.set(b.device, list);
    for (const e of b.events) {
      if (e.writer === this.id) continue;
      const pt = this.now();
      const warning = this.#clock.receive(e.hlc);
      this.#farAhead.set(e.writer, warning !== undefined || parseHlc(e.hlc).wall > pt + MAX_SKEW);
    }
    if (!this.devices) return true;
    const report = this.gate.ingest(b.events);
    this.#reject(report.rejectedFrames);
    return true;
  }

  /** D8: data the view holds is no longer accepted: rebuild the data view from what is held. */
  #reject(rejections: readonly FrameRejection[]): void {
    if (rejections.length === 0) return;
    this.rejections.push(...rejections);
    this.#accepted.clear();
    this.cursors.clear();
    this.devices.guard.reset();
  }

  /** Extends every writer's accepted data as far as the guard allows (until nothing changes). */
  #settle(): void {
    if (!this.devices) return;
    for (let changed = true; changed; ) {
      changed = false;
      for (const [device, list] of this.#downloaded) {
        const accepted = this.#accepted.get(device) ?? [];
        const last = accepted[accepted.length - 1]?.cursor;
        for (const b of list) {
          if (last && comparePositions(b.cursor, last) <= 0) continue;
          const at = { device, end: b.cursor };
          if (!this.devices.guard.check(at).ok) break;
          this.devices.guard.record(at);
          accepted.push(b);
          this.cursors.set(device, b.cursor);
          changed = true;
        }
        this.#accepted.set(device, accepted);
      }
      if (changed) this.#reject(this.devices.guard.recheck());
    }
  }

  /** Eids of the accepted data, sorted (what the view holds, by content). */
  acceptedEids(): string[] {
    const out: string[] = [];
    for (const list of this.#accepted.values())
      for (const b of list) for (const e of b.events) out.push(e.eid);
    return out.sort();
  }

  /** Accepted data as `writer@offset`, sorted (for convergence checks). */
  acceptedData(): string[] {
    const out: string[] = [];
    for (const [device, list] of this.#accepted) {
      for (const b of list) out.push(`${device}@${b.cursor.offset}`);
    }
    return out.sort();
  }

  /** The clock is suspect when most peers heard from are more than the skew ahead of it. */
  clockOk(): boolean {
    const flags = [...this.#farAhead.values()];
    return flags.filter(Boolean).length * 2 <= flags.length;
  }

  local(): LeaseLocal {
    return {
      me: this.id,
      now: this.now(),
      lastPullAt: this.lastPullAt,
      transport: this.assumeBounded
        ? {
            kind: "bounded",
            propagationMs: 0,
            lastPullAt: this.lastPullAt ?? 0,
            lastPushAt: this.lastPushAt ?? 0,
          }
        : this.remote.report(this.lastPullAt, this.lastPushAt),
      own: (eid: string) => this.own.get(eid),
      firstSeen: (eid: string) => this.devices.firstSeen(eid),
      clockOk: this.clockOk(),
    };
  }
}

export interface SimVault {
  readonly remote: SimRemote;
  readonly recovery: RecoveryIdentity;
  /** The recovery-signed base wrap made at vault creation (a restoring device seeds from it). */
  readonly recoveryWrap: Uint8Array;
  readonly creator: SimDevice;
  readonly vaultId: string;
}

/** A vault created on `creator` (recovery words on screen), creator announced in its own stream. */
export function createSimVault(remote = new SimRemote(), skewMs = 0): SimVault {
  const { phrase } = createRecoveryKey(sodium);
  const recovery = recoveryIdentity(sodium, phrase);
  const creator = new SimDevice("creator", remote, skewMs);
  creator.words = recovery;
  const vault = createVaultWithRecovery(sodium, recovery, creator.identity);
  creator.attach(vault.ring, [vault.creatorCertificate]);
  const subject = {
    deviceId: creator.id,
    signPublicKey: creator.identity.signPublicKey,
    boxPublicKey: creator.identity.box.publicKey,
  };
  // The creator announces itself and, in the same batch, the creator pin (the fetch leader, D3).
  creator.write([
    buildDeviceAdded(
      creator.identity,
      vault.ring.vaultId,
      newEid(),
      subject,
      "creator",
      vault.creatorCertificate,
    ),
    creatorPin(creator.identity, recovery, vault.ring.vaultId, newEid(), creator.now()),
  ]);
  creator.push();
  return {
    remote,
    recovery,
    recoveryWrap: vault.recoveryWrap,
    creator,
    vaultId: vault.ring.vaultId,
  };
}

/** Two ends of an in-memory link; `tap` may observe or replace messages in flight. */
export function memoryLinks(
  tap: {
    toInviter?: (m: Uint8Array) => Uint8Array | undefined;
    toJoiner?: (m: Uint8Array) => Uint8Array | undefined;
  } = {},
): { inviter: PairingLink; joiner: PairingLink } {
  const queue = (): { push: (m: Uint8Array) => void; next: () => Promise<Uint8Array> } => {
    const items: Uint8Array[] = [];
    const waiters: ((m: Uint8Array) => void)[] = [];
    return {
      push: (m) => {
        const w = waiters.shift();
        if (w) w(m);
        else items.push(m);
      },
      next: () => {
        const m = items.shift();
        if (m) return Promise.resolve(m);
        return new Promise((resolve, reject) => {
          waiters.push(resolve);
          setTimeout(() => reject(new Error("link timeout")), 2000);
        });
      },
    };
  };
  const toInviter = queue();
  const toJoiner = queue();
  return {
    inviter: {
      send: async (m) => {
        const out = tap.toJoiner ? tap.toJoiner(m) : m;
        if (out) toJoiner.push(out);
      },
      receive: () => toInviter.next(),
    },
    joiner: {
      send: async (m) => {
        const out = tap.toInviter ? tap.toInviter(m) : m;
        if (out) toInviter.push(out);
      },
      receive: () => toJoiner.next(),
    },
  };
}

/**
 * Pairs a new simulated device through the real protocol over an in-memory link (the owner types
 * the code the new device shows into the inviter), writes the inviter's `device.added` and pushes it.
 */
export async function pairDevice(
  inviter: SimDevice,
  name: string,
  skewMs = 0,
  options: { readonly sharedCaches?: boolean } = {},
): Promise<SimDevice> {
  const caches = options.sharedCaches
    ? { verify: inviter.verify, certificateCache: inviter.certificateCache }
    : undefined;
  const joiner = new SimDevice(name, inviter.remote, skewMs, undefined, caches);
  joiner.words = inviter.words;
  const created = PairingInviter.create({
    sodium,
    identity: inviter.identity,
    ring: inviter.ring,
    registry: inviter.devices.registry,
    now: inviter.now(),
  });
  if (!created.ok) throw new Error(`invite failed: ${created.reason}`);
  const started = PairingJoiner.start(
    {
      sodium,
      identity: joiner.identity,
      name,
      verify: joiner.verify,
      certificateCache: joiner.certificateCache,
    },
    created.value.qr,
    joiner.now(),
  );
  if (!started.ok) throw new Error(`scan failed: ${started.reason}`);
  const links = memoryLinks();
  let joinerSas: string | undefined;
  const [inv, join] = await Promise.all([
    runInviter(created.value.inviter, links.inviter, {
      now: () => inviter.now(),
      enterCode: async () => joinerSas,
      eid: newEid,
    }),
    runJoiner(started.value.joiner, started.value.hello, links.joiner, {
      now: () => joiner.now(),
      showSas: (sas) => {
        joinerSas = sas;
      },
    }),
  ]);
  if (!inv.ok || !join.ok) {
    throw new Error(`pairing failed: ${inv.ok ? "" : inv.reason} ${join.ok ? "" : join.reason}`);
  }
  inviter.write([inv.value.deviceAdded]);
  inviter.push();
  joiner.attach(join.value.ring, [join.value.certificate]);
  recordPairingProvenance(joiner.provenance, join.value.ring, inviter.id, joiner.now());
  joiner.devices.ingest(join.value.registryEvents);
  joiner.pull();
  return joiner;
}

export { START_CURSOR };

/**
 * The owner opts into automatic handover on `d` (typed confirmation, forced: tests that write raw
 * claims start from here). `d`'s remote must declare bounded propagation.
 */
export function optInAutoHandover(d: SimDevice): void {
  const write = {
    identity: d.identity,
    vaultId: d.ring.vaultId,
    eid: newEid(),
    now: d.now(),
    applied: d.applied,
  };
  const request = {
    mode: "auto" as const,
    leader: null,
    force: true,
    confirmation: { kind: "typed" as const, text: pinConfirmationText("auto", null, true) },
  };
  d.write([pinEventFor(d.devices.lease, write, request, d.local())]);
}

/** A small seeded PRNG for reproducible schedules (tests only). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The consents of `targets` (devices in the owner's hands) to the revocation `eid` of `entries` by
 * `signer` (H2): what each target signs when the owner confirms on it.
 */
export function consentsOf(
  targets: readonly (SimDevice | DeviceIdentity)[],
  vaultId: string,
  eid: string,
  entries: readonly RevokedEntry[],
  signer: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of targets) {
    const identity = t instanceof SimDevice ? t.identity : t;
    if (identity.deviceId === signer) continue;
    out[identity.deviceId] = consentToRevocation(identity, vaultId, eid, entries, signer);
  }
  return out;
}

/** Synthetic owner review in protocol tests. Production uses a host-bound, expiring challenge. */
export function prepareReviewedRevocation(
  revoker: SimDevice,
  proposed: readonly RevokedEntry[],
  eids: { readonly revoke: string; readonly rotate: string; readonly recertify?: () => string },
  authority: RecoveryIdentity | { readonly consent: Readonly<Record<string, string>> },
  selection: { readonly recertify?: readonly string[] } = {},
) {
  const targets = proposed.map((entry) => ({ device: entry.device, applied: entry.cut }));
  const request: RevocationPreviewRequest = {
    targets,
    revokeEid: eids.revoke,
    attemptId: newEid(),
    authority:
      "consent" in authority
        ? { kind: "consent", signatures: authority.consent }
        : { kind: "recovery" },
    selection: { recertify: selection.recertify ?? [] },
  };
  const observed = previewRevocation(revoker.devices, revoker.gate, request);
  if (!observed.ok) return { ok: false as const, reason: "revocation_admission_required" as const };
  const permit = acknowledgeRevocationPreview(observed.preview, {
    warning: "acknowledged",
    ...(observed.preview.requiresLocalStartConfirmation
      ? { localStart: "local_never_seen" as const }
      : {}),
  });
  if (!permit) return { ok: false as const, reason: "revocation_admission_required" as const };
  return revoker.devices.prepareRevocation(
    revoker.gate,
    request,
    permit,
    eids,
    authority,
    selection,
  );
}

/**
 * Prepares the honest revoke flow (nothing is written): with the targets' consent when it counts
 * (H2 / H5': the revoker did not certify them), else with the owner's recovery words.
 */
export function prepareConsented(
  revoker: SimDevice,
  targets: readonly SimDevice[],
  recovery?: RecoveryIdentity,
  /** The orphans the owner chose to re-certify (default none, W1). */
  recertify: readonly SimDevice[] = [],
) {
  const selection = { recertify: recertify.map((d) => d.id) };
  // Consent covers the exact cut and head held by the revoker; no target-supplied cut bypasses
  // the checked local observation.
  const own = targets.map((t) =>
    revoker.gate.revocationEntry(t.id, revoker.cursors.get(t.id) ?? START_CURSOR),
  );
  const eid = newEid();
  const consent = consentsOf(targets, revoker.ring.vaultId, eid, own, revoker.id);
  const eids = { revoke: eid, rotate: newEid(), recertify: newEid };
  const result = prepareReviewedRevocation(revoker, own, eids, { consent }, selection);
  const words = recovery ?? revoker.words;
  if (!result.ok && result.reason === "authority_required" && words) {
    // Words path (rule 1): the revoker's own view of each target, never below its last lease event.
    const words2 = { revoke: newEid(), rotate: eids.rotate, recertify: newEid };
    return prepareReviewedRevocation(revoker, own, words2, words, selection);
  }
  return result;
}

/**
 * The honest revoke flow with the targets' consent: prepares, writes the batch and commits. Throws
 * when the flow refuses (tests that expect a refusal call `prepareRevocation` themselves).
 */
export function revokeWithConsent(
  revoker: SimDevice,
  targets: readonly SimDevice[],
  recovery?: RecoveryIdentity,
): Batch {
  const result = prepareConsented(revoker, targets, recovery);
  if (!result.ok) throw new Error(`revocation refused: ${result.reason}`);
  const batch = revoker.write(result.change.events);
  result.change.commit();
  return batch;
}

/** A device-signed `device.revoked` carrying the consents of `consenters` (fold-level tests). */
export function revokedWithConsent(
  signer: DeviceIdentity,
  vaultId: string,
  entries: readonly RevokedEntry[],
  consenters: readonly (SimDevice | DeviceIdentity)[],
  eid: string = newEid(),
): UnstampedEvent {
  const consent = consentsOf(consenters, vaultId, eid, entries, signer.deviceId);
  return buildDeviceRevoked(signer, vaultId, eid, entries, { consent });
}
