// Multi-device simulation for the devices tests (synthetic data only). Not exported from the package.
//
// Each simulated device holds its own identity, ring, `VaultDevices` state, HLC clock (with its own
// skew against the simulated true time) and its own append-only stream of batches. One batch is one
// frame here, sealed under the writer's active key (its key order is recorded with the batch). A
// shared remote keeps every pushed batch (and lets a test rewrite one, as untrusted storage can).
//
// A device models the store + codec contract of guard.ts: it downloads every batch in per-device
// order, passes the statements of EVERY downloaded batch to `VaultDevices.ingest` (also batches the
// guard rejects), and applies a batch's data only through the guard: per writer, the accepted data
// is the longest prefix that passes `guard.check`; when an ingest reports rejected frames, the
// device drops that writer's data after the reported position and re-applies from there.

import type { SegmentCursor, UnstampedEvent } from "../carrier.js";
import { START_CURSOR } from "../carrier.js";
import {
  CertificateCache,
  createDeviceIdentity,
  createRecoveryKey,
  createVaultWithRecovery,
  type DeviceIdentity,
  type Keyring,
  loadNodeSodium,
  type RecoveryIdentity,
  recoveryIdentity,
  type Sodium,
} from "../crypto/index.js";
import { formatHlc, type Hlc, HybridClock, parseHlc } from "../hlc.js";
import {
  buildDeviceAdded,
  buildDeviceRevoked,
  consentToRevocation,
  type LogEvent,
  type RevokedEntry,
} from "./events.js";
import type { FrameRejection, KeyOrder } from "./guard.js";
import type { LeaseLocal, OwnLeaseRecord } from "./lease.js";
import { PairingInviter, PairingJoiner } from "./pairing.js";
import { type PairingLink, runInviter, runJoiner } from "./pairingLink.js";
import { comparePositions } from "./positions.js";
import { MemoryProvenanceStore } from "./provenance.js";
import { recordPairingProvenance } from "./rotation.js";
import { memoizedVerifier, type StatementVerifier } from "./statements.js";
import { VaultDevices } from "./vaultDevices.js";

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
  /** The key the writer sealed it under. */
  readonly key: KeyOrder;
}

export class SimRemote {
  readonly batches = new Map<string, Batch[]>();
  /** Simulated true time, ms. */
  time = START_TIME;

  publish(batch: Batch): void {
    const list = this.batches.get(batch.device) ?? [];
    if (!list.some((b) => b.cursor.offset === batch.cursor.offset)) list.push(batch);
    list.sort((x, y) => comparePositions(x.cursor, y.cursor));
    this.batches.set(batch.device, list);
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
  readonly verify: StatementVerifier = memoizedVerifier();
  readonly certificateCache = new CertificateCache();
  skewMs: number;
  lastPullAt: number | undefined;
  /** The vault's recovery words, as the owner knows them (the honest revoke helpers fall back to them). */
  words: RecoveryIdentity | undefined;
  devices!: VaultDevices;
  #bootstrap: readonly Uint8Array[] = [];
  #clock: HybridClock;
  #pushed = 0;
  #offset = 0;
  /** Downloaded batches per writer, in stream order (statements already ingested). */
  readonly #downloaded = new Map<string, Batch[]>();
  /** Accepted data per writer: the batches whose data is in this device's view. */
  readonly #accepted = new Map<string, Batch[]>();
  /** Peers whose latest events were more than the skew ahead of this clock (HLC warnings). */
  readonly #farAhead = new Map<string, boolean>();

  constructor(name: string, remote: SimRemote, skewMs = 0, identity?: DeviceIdentity) {
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
    const active = this.devices.ring.active;
    const key = { epoch: active.epoch, generation: active.generation };
    const batch: Batch = { device: writer, events: stamped, start, cursor, key };
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
  }

  /** Downloads every batch not downloaded yet, in per-device order (`filter` false stops a stream). */
  pull(filter: (b: Batch) => boolean = () => true): void {
    for (const device of [...this.remote.batches.keys()].sort()) {
      if (device === this.id) continue;
      const have = this.#downloaded.get(device) ?? [];
      const last = have[have.length - 1]?.cursor;
      for (const b of this.remote.batches.get(device) ?? []) {
        if (last && comparePositions(b.cursor, last) <= 0) continue;
        if (!filter(b)) break;
        this.#download(b);
      }
    }
    this.#settle();
    this.lastPullAt = this.now();
  }

  sync(): void {
    this.push();
    this.pull();
  }

  /** Forgets the view and the devices state and downloads everything again (a store rebuild). */
  rebuild(): void {
    this.#downloaded.clear();
    this.#accepted.clear();
    this.cursors.clear();
    const ring = this.devices.ring;
    this.attach(ring, this.#bootstrap);
    for (const b of this.stream) this.#download(b);
    this.pull();
  }

  #download(b: Batch): void {
    const list = this.#downloaded.get(b.device) ?? [];
    list.push(b);
    this.#downloaded.set(b.device, list);
    for (const e of b.events) {
      if (e.writer === this.id) continue;
      const pt = this.now();
      const warning = this.#clock.receive(e.hlc);
      this.#farAhead.set(e.writer, warning !== undefined || parseHlc(e.hlc).wall > pt + MAX_SKEW);
    }
    if (!this.devices) return;
    const report = this.devices.ingest(b.events);
    this.#reject(report.rejectedFrames);
  }

  #reject(rejections: readonly FrameRejection[]): void {
    for (const r of rejections) {
      this.rejections.push(r);
      const kept = (this.#accepted.get(r.device) ?? []).filter(
        (b) => comparePositions(b.cursor, r.after) <= 0,
      );
      this.#accepted.set(r.device, kept);
      const last = kept[kept.length - 1];
      if (last) this.cursors.set(r.device, last.cursor);
      else this.cursors.delete(r.device);
    }
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
          const at = { device, start: b.start, end: b.cursor };
          if (!this.devices.guard.check(at, b.key).ok) break;
          this.devices.guard.record(at, b.key);
          accepted.push(b);
          this.cursors.set(device, b.cursor);
          changed = true;
        }
        this.#accepted.set(device, accepted);
      }
      if (changed) this.#reject(this.devices.guard.recheck());
    }
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
  creator.write([
    buildDeviceAdded(
      creator.identity,
      vault.ring.vaultId,
      newEid(),
      subject,
      "creator",
      vault.creatorCertificate,
    ),
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
export async function pairDevice(inviter: SimDevice, name: string, skewMs = 0): Promise<SimDevice> {
  const joiner = new SimDevice(name, inviter.remote, skewMs);
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
  const entries = targets.map((t) => ({
    device: t.id,
    cut: revoker.cursors.get(t.id) ?? START_CURSOR,
  }));
  const eid = newEid();
  const consent = consentsOf(targets, revoker.ring.vaultId, eid, entries, revoker.id);
  const eids = { revoke: eid, rotate: newEid(), recertify: newEid };
  const result = revoker.devices.prepareRevocation(entries, eids, { consent }, selection);
  const words = recovery ?? revoker.words;
  if (!result.ok && result.reason === "authority_required" && words) {
    return revoker.devices.prepareRevocation(entries, eids, words, selection);
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
