// Multi-device simulation for the devices tests (synthetic data only). Not exported from the package.
//
// Each simulated device holds its own identity, ring, `VaultDevices` state, HLC clock (with its own
// skew against the simulated true time) and its own append-only stream of batches. A shared remote
// keeps every pushed batch; `pull` hands a device the batches it has not seen, in per-device order,
// as the engine would.

import type { SegmentCursor, UnstampedEvent } from "../carrier.js";
import {
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
import { formatHlc, type Hlc, HybridClock } from "../hlc.js";
import { buildDeviceAdded, type LogEvent } from "./events.js";
import type { OwnLeaseRecord } from "./lease.js";
import { PairingInviter, PairingJoiner } from "./pairing.js";
import { type PairingLink, runInviter, runJoiner } from "./pairingLink.js";
import { MemoryProvenanceStore } from "./provenance.js";
import { recordPairingProvenance } from "./rotation.js";
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

export interface Batch {
  readonly device: string;
  readonly events: readonly LogEvent[];
  readonly cursor: SegmentCursor;
}

export class SimRemote {
  readonly batches = new Map<string, Batch[]>();
  /** Simulated true time, ms. */
  time = START_TIME;

  publish(batch: Batch): void {
    const list = this.batches.get(batch.device) ?? [];
    if (!list.some((b) => b.cursor.offset === batch.cursor.offset)) list.push(batch);
    this.batches.set(batch.device, list);
  }
}

export class SimDevice {
  readonly name: string;
  readonly identity: DeviceIdentity;
  readonly remote: SimRemote;
  readonly provenance = new MemoryProvenanceStore();
  readonly stream: Batch[] = [];
  readonly own = new Map<string, OwnLeaseRecord>();
  /** Highest applied HLC per writer device (the lease watermark input). */
  readonly applied = new Map<string, Hlc>();
  /** Applied cursor per writer device. */
  readonly cursors = new Map<string, SegmentCursor>();
  skewMs: number;
  lastPullAt: number | undefined;
  devices!: VaultDevices;
  #clock: HybridClock;
  #pushed = 0;
  #offset = 0;

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

  /** This device's wall clock. */
  now(): number {
    return this.remote.time + this.skewMs;
  }

  attach(
    ring: Keyring,
    bootstrapCertificates: readonly Uint8Array[],
    recovering?: { highestRecoveryEpoch: number },
  ): void {
    this.devices = new VaultDevices({
      sodium,
      identity: this.identity,
      ring,
      provenance: this.provenance,
      clock: () => this.now(),
      bootstrapCertificates,
      ...(recovering ? { recovering } : {}),
    });
  }

  /** Stamps and appends one batch to this device's own stream and applies it locally. */
  write(events: readonly UnstampedEvent[]): LogEvent[] {
    this.#offset += 100;
    const cursor = { seg: 1, offset: this.#offset };
    const stamped: LogEvent[] = events.map((e) => ({
      eid: e.i,
      hlc: this.#clock.tick(),
      writer: this.id,
      position: cursor,
      type: e.t,
      v: e.v,
      data: e.d,
    }));
    this.stream.push({ device: this.id, events: stamped, cursor });
    for (const e of stamped) {
      if (e.type.startsWith("lease.")) this.own.set(e.eid, { writtenAt: this.now() });
    }
    this.#apply(this.id, stamped, cursor);
    return stamped;
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

  /** Pulls every batch this device has not applied, in per-device order. */
  pull(filter: (b: Batch) => boolean = () => true): void {
    for (const [device, list] of this.remote.batches) {
      if (device === this.id) continue;
      const from = this.cursors.get(device);
      for (const b of [...list].sort((x, y) => x.cursor.offset - y.cursor.offset)) {
        if (from && b.cursor.offset <= from.offset) continue;
        if (!filter(b)) break;
        this.#apply(device, b.events, b.cursor);
      }
    }
    this.lastPullAt = this.now();
  }

  sync(): void {
    this.push();
    this.pull();
  }

  #apply(device: string, events: readonly LogEvent[], cursor: SegmentCursor): void {
    for (const e of events) {
      this.#clock.receive(e.hlc);
      const prev = this.applied.get(device);
      if (prev === undefined || prev < e.hlc) this.applied.set(device, e.hlc);
    }
    this.cursors.set(device, cursor);
    this.devices?.ingest(events);
  }

  local() {
    return {
      me: this.id,
      now: this.now(),
      lastPullAt: this.lastPullAt,
      own: (eid: string) => this.own.get(eid),
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
 * Pairs a new simulated device through the real protocol over an in-memory link (the owner
 * confirms because both screens match), writes the inviter's `device.added` and pushes it.
 */
export async function pairDevice(inviter: SimDevice, name: string, skewMs = 0): Promise<SimDevice> {
  const joiner = new SimDevice(name, inviter.remote, skewMs);
  const created = PairingInviter.create({
    sodium,
    identity: inviter.identity,
    ring: inviter.ring,
    registry: inviter.devices.registry,
    now: inviter.now(),
  });
  if (!created.ok) throw new Error(`invite failed: ${created.reason}`);
  const started = PairingJoiner.start(
    { sodium, identity: joiner.identity, name },
    created.value.qr,
    joiner.now(),
  );
  if (!started.ok) throw new Error(`scan failed: ${started.reason}`);
  const links = memoryLinks();
  let joinerSas: string | undefined;
  const [inv, join] = await Promise.all([
    runInviter(created.value.inviter, links.inviter, {
      now: () => inviter.now(),
      confirmSas: async (sas) => sas === joinerSas,
      eid: newEid,
    }),
    runJoiner(started.value.joiner, started.value.hello, links.joiner, {
      now: () => joiner.now(),
      showSas: (sas) => {
        joinerSas = sas;
      },
    }),
  ]);
  if (!inv.ok || !join.ok) throw new Error("pairing failed");
  inviter.write([inv.value.deviceAdded]);
  inviter.push();
  joiner.attach(join.value.ring, [join.value.certificate]);
  recordPairingProvenance(joiner.provenance, join.value.ring, inviter.id, joiner.now());
  joiner.devices.ingest(join.value.registryEvents);
  joiner.pull();
  return joiner;
}
