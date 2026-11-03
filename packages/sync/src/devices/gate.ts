// The frame gate (carrier.ts `FrameGate`) over one device's `VaultDevices` (S29c phase B2): the one
// place that decides whether a frame was signed by its writer, feeds the statements of every signed
// frame to the registry, turns signed heads carried in revocation cuts into fork freezes, and
// decides whether a frame's data is accepted. The engine (and the carrier, for manifest records)
// calls it for every frame it opens; the device test kit (testkit.ts) drives the same object.
//
// A frame of writer W at end e is SIGNED BY W when its head (chain recomputed by the codec from W's
// previous frame) verifies through acceptance.ts with:
// - W's stream key once one frame of that stream verified (heads.ts: one key per stream), as long
//   as the registry still certifies it for W;
// - before that, any key certified for W through a chain from the recovery key, revocations
//   ignored (`Registry.authorKeys`), or the subject key of a recovery-issued certificate for W that
//   the frame itself carries in W's own `device.added` (a creator, a genesis device or a device the
//   words certified introduces itself in its first frame).
// No candidate key: the writer is not known yet (`wait`: its certificate has not arrived, retried
// after the next registry change; the frame is neither copied nor ingested). Candidates but no
// signature match: `bad_head_signature` (tampered, forged, rewritten or reordered).

import type {
  DeviceId,
  FrameGate,
  FrameHead,
  GateVerdict,
  SegmentCursor,
  WireEvent,
} from "../carrier.js";
import {
  decodeHead,
  encodeHead,
  type SignedHead,
  type Sodium,
  verifyCertificates,
} from "../crypto/index.js";
import { acceptedHead } from "./acceptance.js";
import { equalBytes, fromHex } from "./bytes.js";
import {
  DEVICE_ADDED,
  DEVICE_REVOKED,
  decodeDeviceAdded,
  decodeDeviceRevoked,
  type LogEvent,
  type RevokedEntry,
} from "./events.js";
import { decodeEvidence, decodeGateState, encodeEvidence, encodeGateState } from "./gateState.js";
import type { FrameRejection } from "./guard.js";
import { type BehindReport, type ForkReport, StreamIndex } from "./heads.js";
import { comparePositions } from "./positions.js";
import type { StatementVerifier } from "./statements.js";
import { memoizedVerifier } from "./statements.js";
import type { IngestReport, VaultDevices } from "./vaultDevices.js";

export interface DeviceFrameGateOptions {
  readonly sodium: Sodium;
  /** Shared with the devices state when it has one (signature results are cached). */
  readonly verify?: StatementVerifier;
}

/** The log events of a frame's wire events (writer and position from the head). */
export function logEventsOf(head: FrameHead, events: readonly WireEvent[]): LogEvent[] {
  const position = { seg: head.seg, offset: head.offset };
  return events.map((e) => ({
    eid: e.i,
    hlc: e.h,
    writer: head.device,
    position,
    type: e.t,
    v: e.v,
    data: e.d,
  }));
}

export class DeviceFrameGate implements FrameGate {
  readonly heads = new StreamIndex();
  readonly #devices: VaultDevices;
  readonly #sodium: Sodium;
  readonly #verify: StatementVerifier;
  #rebuild = false;
  /** Every rejection reported (data no longer accepted), for tests and the UI's history. */
  readonly rejections: FrameRejection[] = [];
  /** Every `device.*` / `lease.*` event ingested, by copy (the snapshot replays them). */
  readonly #statements = new Map<string, LogEvent>();
  /** Fork proofs held (recorded or imported), and those not handed out for persistence yet. */
  readonly #evidence = new Set<string>();
  #newEvidence: string[] = [];

  constructor(devices: VaultDevices, options: DeviceFrameGateOptions) {
    this.#devices = devices;
    this.#sodium = options.sodium;
    this.#verify = options.verify ?? memoizedVerifier();
  }

  get devices(): VaultDevices {
    return this.#devices;
  }

  authenticate(head: FrameHead, events: readonly WireEvent[]): GateVerdict {
    const vaultId = this.#devices.ring.vaultId;
    const registry = this.#devices.registry;
    const bound = this.heads.boundKey(head.device, head.stream);
    const authors = registry.authorKeys(head.device);
    let key: Uint8Array | undefined;
    if (bound) {
      const intro = this.#introducedKeys(head.device, events);
      if (![...authors, ...intro].some((k) => equalBytes(k, bound))) {
        return { ok: false, wait: true, code: "writer-unknown" };
      }
      key = acceptedHead(this.#verify, vaultId, head, { kind: "author", keys: [bound] });
    } else {
      const intro = this.#introducedKeys(head.device, events).filter(
        (k) => !authors.some((a) => equalBytes(a, k)),
      );
      if (authors.length + intro.length === 0) {
        return { ok: false, wait: true, code: "writer-unknown" };
      }
      if (authors.length + intro.length > 1) {
        // Two key pairs certified for one device (a thief minted one): the stream is bound only to
        // the key the trust resolves (its decision key), never to whichever signed first; until the
        // trust resolves it, the stream waits (fail closed).
        const resolved = this.#resolvedKey(head.device);
        if (!resolved) return { ok: false, wait: true, code: "writer-ambiguous" };
        key = acceptedHead(this.#verify, vaultId, head, { kind: "author", keys: [resolved] });
      } else if (authors.length === 1) {
        key = acceptedHead(this.#verify, vaultId, head, { kind: "author", keys: authors });
      } else {
        key = acceptedHead(this.#verify, vaultId, head, {
          kind: "admission",
          signKey: intro[0] as Uint8Array,
        });
      }
    }
    if (!key) return { ok: false, wait: false, code: "bad_head_signature" };
    this.heads.bind(head.device, head.stream, key);
    if (head.stream === 1) this.heads.observe(head);
    return { ok: true };
  }

  /**
   * The statements of a verified data frame: registry and lease events go to the devices state,
   * signed heads in revocation cuts become attestations, and the fork freezes are recomputed.
   */
  ingest(events: readonly LogEvent[]): IngestReport {
    for (const e of events) {
      if (e.type.startsWith("device.") || e.type.startsWith("lease.")) {
        this.#statements.set(statementKey(e), e);
      }
    }
    for (const e of events) {
      if (e.type !== DEVICE_REVOKED) continue;
      for (const entry of decodeDeviceRevoked(e.data)?.devices ?? []) {
        const head = entry.head === undefined ? undefined : decodeHead(entry.head);
        if (head) this.heads.attest(head);
      }
    }
    const report = this.#devices.ingest(events);
    const frozen = this.#devices.freeze(this.#freezes());
    if (frozen !== undefined) this.#recordProofs();
    const rejected = [...report.rejectedFrames, ...(frozen?.rejectedFrames ?? [])];
    if (rejected.length > 0) {
      this.rejections.push(...rejected);
      this.#rebuild = true;
    }
    return {
      ...report,
      rejectedFrames: rejected,
      registryChanged: report.registryChanged || frozen !== undefined,
    };
  }

  observe(head: FrameHead, events: readonly WireEvent[]): void {
    this.ingest(logEventsOf(head, events));
  }

  accept(
    head: FrameHead,
    events: readonly WireEvent[],
  ): { readonly verdict: GateVerdict; readonly changed: boolean } {
    const report = this.ingest(logEventsOf(head, events));
    const at = { device: head.device, end: { seg: head.seg, offset: head.offset } };
    const verdict = this.#devices.guard.check(at);
    if (!verdict.ok) {
      return {
        verdict: { ok: false, wait: false, code: verdict.reason },
        changed: report.registryChanged,
      };
    }
    this.#devices.guard.record(at);
    return { verdict: { ok: true }, changed: report.registryChanged };
  }

  /**
   * The devices state is rebuilt from the log on every start, from the snapshot's positions when the
   * engine restored one (`importState`, S29c-B3), else from the start of every stream.
   */
  needsReplay(): boolean {
    return true;
  }

  /** Fork proofs found since the last call, for the append-only evidence record. */
  takeEvidence(): readonly string[] {
    const out = this.#newEvidence;
    this.#newEvidence = [];
    return out;
  }

  recoveryEvidenceDevices(): readonly DeviceId[] {
    const devices = new Set<DeviceId>();
    for (const record of this.#evidence) {
      const pair = decodeEvidence(record);
      if (pair?.every((head) => this.#genuine(head))) devices.add(pair[0].device);
    }
    return [...devices].sort();
  }

  /**
   * Restores fork proofs from the evidence record (before the snapshot and the replay): each one
   * that decodes as two heads of one writer at one end with different chains is attested; its
   * signatures are judged against the writer's stream key whenever freezes are computed.
   */
  importEvidence(records: readonly string[]): void {
    let added = false;
    for (const record of records) {
      const pair = decodeEvidence(record);
      if (!pair || this.#evidence.has(record)) continue;
      this.#evidence.add(record);
      for (const head of pair) this.heads.attest(head);
      added = true;
    }
    if (added) this.ingest([]);
  }

  #recordProofs(): void {
    for (const pair of this.heads.proofs((h) => this.#genuine(h))) {
      const record = encodeEvidence(pair);
      if (this.#evidence.has(record)) continue;
      this.#evidence.add(record);
      this.#newEvidence.push(record);
    }
  }

  exportState(positions: ReadonlyMap<DeviceId, FrameHead>): string | undefined {
    const devices = this.#devices;
    try {
      return encodeGateState(
        devices.ring.vaultId,
        devices.deviceId,
        {
          positions: [...positions.values()],
          keys: this.heads.exportKeys(),
          heads: this.heads.exportHeads(),
          statements: [...this.#statements.values()],
          applied: devices.guard.entries(),
        },
        (body) => devices.signLocalState(body),
      );
    } catch {
      return undefined; // the identity is wiped (a retired device): nothing to persist
    }
  }

  importState(state: string):
    | {
        readonly positions: ReadonlyMap<DeviceId, FrameHead>;
        readonly heldHeads?: readonly FrameHead[];
        restore(): void;
      }
    | undefined {
    const devices = this.#devices;
    const snapshot = decodeGateState(
      state,
      devices.ring.vaultId,
      devices.deviceId,
      devices.signPublicKey,
      this.#verify,
    );
    if (!snapshot) return undefined;
    return {
      positions: new Map(snapshot.positions.map((h) => [h.device, h])),
      heldHeads: snapshot.heads.map(({ head }) => head),
      restore: () => {
        this.heads.restore(snapshot.keys, snapshot.heads);
        this.ingest(snapshot.statements);
        for (const [device, end] of snapshot.applied) devices.guard.record({ device, end });
        this.#rebuild = false;
      },
    };
  }

  takeRebuild(): boolean {
    const rebuild = this.#rebuild;
    this.#rebuild = false;
    return rebuild;
  }

  reset(): void {
    this.#devices.guard.reset();
    this.#rebuild = false;
  }

  /** The verified head of `device` ending exactly at `end`, encoded for a revocation cut. */
  headAt(device: string, end: SegmentCursor): string | undefined {
    const head = this.heads.headAt(device, end);
    return head ? encodeHead(head) : undefined;
  }

  /**
   * The revoke flow's entry for `target` (S44 contract; cut-before-ack rule 1): the cut is this
   * device's applied cursor of the target, never below the last lease event of the target it holds
   * (an acknowledgement of a fetch-leader hand-over must not end up after the cut, B1 review), and
   * it carries the target's signed head at the cut when this device holds a frame ending there.
   * The flow syncs before calling it, so "what it holds" is as fresh as it can be.
   */
  revocationEntry(target: string, applied: SegmentCursor): RevokedEntry {
    const lease = this.#devices.lastLeaseEventOf(target);
    const cut = lease && comparePositions(lease, applied) > 0 ? lease : applied;
    const head = this.headAt(target, cut);
    return { device: target, cut, ...(head === undefined ? {} : { head }) };
  }

  /**
   * This device's own entry for a revocation it consents to (cut-before-ack rule 2): the cut is its
   * own last stream position, with its own signed head there, so nothing it wrote (an
   * acknowledgement included) falls after the cut.
   */
  ownEntry(): RevokedEntry {
    const me = this.#devices.deviceId;
    const cut = this.heads.held(me) ?? { seg: 1, offset: 0 };
    const head = this.headAt(me, cut);
    return { device: me, cut, ...(head === undefined ? {} : { head }) };
  }

  /** Writers proven forked and the prefix they are frozen at (lead decision D5: tell the owner). */
  forks(): ForkReport[] {
    return this.heads.forks((h) => this.#genuine(h));
  }

  /** Writers that other devices attest further ahead than this device holds (withholding?). */
  behind(): BehindReport[] {
    return this.heads.behind((h) => this.#genuine(h));
  }

  #freezes(): Map<string, SegmentCursor> {
    return new Map(this.forks().map((f) => [f.device, f.agreed]));
  }

  /** An attested head counts only when the writer's stream key (else an author key) signed it. */
  #genuine(head: SignedHead): boolean {
    const bound = this.heads.boundKey(head.device, head.stream);
    const keys = bound ? [bound] : this.#devices.registry.authorKeys(head.device);
    return (
      acceptedHead(this.#verify, this.#devices.ring.vaultId, head, { kind: "author", keys }) !==
      undefined
    );
  }

  /** The one key the trust resolves for `device`: trusted, or the single decision key of a revoked one. */
  #resolvedKey(device: string): Uint8Array | undefined {
    const registry = this.#devices.registry;
    const trusted = registry.decisionKeys.trustedKeyOf(device);
    if (trusted) return trusted;
    if (!registry.revoked.has(device)) return undefined;
    const keys = registry.decisionKeys.signKeysOf(device);
    return keys.length === 1 ? keys[0] : undefined;
  }

  /** Subject keys of recovery-issued certificates for `device` announced by itself in `events`. */
  #introducedKeys(device: string, events: readonly WireEvent[]): Uint8Array[] {
    const out: Uint8Array[] = [];
    const ring = this.#devices.ring;
    for (const e of events) {
      if (e.t !== DEVICE_ADDED || e.v !== 1) continue;
      const data = decodeDeviceAdded(e.d);
      if (!data || data.device !== device || data.signer !== device) continue;
      const cert = fromHex(data.certificate);
      const check = verifyCertificates(
        this.#sodium,
        ring.vaultId,
        ring.recovery.signPublicKey,
        [cert],
        new Set(),
      );
      // One certificate checked against the recovery key alone: it counts only when the recovery
      // identity issued it.
      const subject = check.devices.get(device);
      if (subject) out.push(subject.signPublicKey.slice());
    }
    return out;
  }
}

function statementKey(e: LogEvent): string {
  // The content is part of the key: a junk copy of a statement never replaces the genuine one.
  const at = `${e.position.seg}:${e.position.offset}`;
  return `${e.eid}|${e.writer}|${at}|${e.hlc}|${e.type}|${e.v}|${JSON.stringify(e.data)}`;
}
