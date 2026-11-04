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
  UnstampedEvent,
  WireEvent,
} from "../carrier.js";
import {
  decodeHead,
  encodeHead,
  RECOVERY_SIGNER_ID,
  type RecoveryIdentity,
  type SignedHead,
  type Sodium,
  verifyCertificates,
} from "../crypto/index.js";
import { accepted, acceptedHead } from "./acceptance.js";
import { equalBytes, fromHex } from "./bytes.js";
import {
  buildHeadsGossiped,
  DEVICE_ADDED,
  DEVICE_REVOKED,
  decodeDeviceAdded,
  decodeDeviceRevoked,
  decodeHeadsGossiped,
  HEADS_GOSSIPED,
  KEYS_ROTATED,
  type LogEvent,
  type RevokedEntry,
  statementBody,
} from "./events.js";
import { decodeEvidence, decodeGateState, encodeEvidence, encodeGateState } from "./gateState.js";
import { GossipLedger, MAX_GOSSIP_HISTORY } from "./gossip.js";
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

export type CheckedRevocationEntry =
  | {
      readonly kind: "trusted_head";
      readonly entry: RevokedEntry & { readonly head: string };
      readonly leaseFloor?: SegmentCursor;
    }
  | {
      readonly kind: "local_start_no_head";
      readonly entry: RevokedEntry & { readonly head?: never };
      readonly leaseFloor?: SegmentCursor;
    }
  | { readonly kind: "integrity_error"; readonly code: "head_missing_at_non_start" };

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
  /** Bounded verified-frame staging; gossip is admitted only after the current guard decision. */
  readonly #gossip = new Map<string, LogEvent>();
  readonly #gossipLatest = new Map<string, SignedHead>();
  readonly #historicalLookups = new Map<string, SignedHead>();
  readonly #historicalResolved = new Set<string>();
  readonly #matchingAnchors = new Map<string, SignedHead>();
  readonly #freezeFloor = new Map<string, SegmentCursor>();
  readonly #ledger = new GossipLedger();
  /** Fork proofs held (recorded or imported), and those not handed out for persistence yet. */
  readonly #evidence = new Set<string>();
  #newEvidence: string[] = [];
  readonly #recoveryBatches = new WeakMap<
    readonly UnstampedEvent[],
    { readonly snapshot: string; readonly revocationCount: number }
  >();

  /** A one-use exception minted only by the checked prepareRevocation path. */
  stageRecoveryRevocationBatch(
    events: readonly UnstampedEvent[],
    authority: RecoveryIdentity,
  ): void {
    const [first, ...rest] = events;
    const data = first?.t === DEVICE_REVOKED ? decodeDeviceRevoked(first.d) : undefined;
    const recertify = data?.recertify ?? [];
    const additions = rest.slice(0, recertify.length);
    const final = rest.slice(recertify.length);
    if (
      !first ||
      !data ||
      data.signer !== RECOVERY_SIGNER_ID ||
      !equalBytes(authority.signPublicKey, this.#devices.registry.recovery.signPublicKey) ||
      data.devices.some((entry) => !this.#devices.registry.isTrusted(entry.device)) ||
      additions.length !== recertify.length ||
      additions.some((event, index) => event?.t !== DEVICE_ADDED || event.i !== recertify[index]) ||
      final.length > 1 ||
      (final.length === 1 && final[0]?.t !== KEYS_ROTATED) ||
      !accepted(
        this.#verify,
        "cashu/registry/v1",
        statementBody(this.#devices.ring.vaultId, first.t, first.i, first.d),
        fromHex(data.sig),
        { kind: "recovery", signKeys: this.#devices.registry.recoverySignKeysFor(first.i) },
      )
    ) {
      throw new RangeError("invalid prepared recovery revocation batch");
    }
    this.#recoveryBatches.set(events, {
      snapshot: JSON.stringify(events),
      revocationCount: this.#devices.registry.revocationCount,
    });
  }

  consumeRecoveryRevocationBatch(
    events: readonly UnstampedEvent[],
  ): readonly UnstampedEvent[] | undefined {
    const pending = this.#recoveryBatches.get(events);
    this.#recoveryBatches.delete(events);
    if (!pending || JSON.stringify(events) !== pending.snapshot) return undefined;
    if (this.#devices.registry.revocationCount !== pending.revocationCount) return undefined;
    const snapshot = JSON.parse(pending.snapshot) as UnstampedEvent[];
    const data = snapshot[0] ? decodeDeviceRevoked(snapshot[0].d) : undefined;
    if (!data || data.devices.some((entry) => !this.#devices.registry.isTrusted(entry.device))) {
      return undefined;
    }
    return snapshot;
  }

  cancelRecoveryRevocationBatch(events: readonly UnstampedEvent[]): void {
    this.#recoveryBatches.delete(events);
  }

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
      if (
        e.type !== HEADS_GOSSIPED &&
        (e.type.startsWith("device.") || e.type.startsWith("lease."))
      ) {
        this.#statements.set(statementKey(e), e);
      }
    }
    const report = this.#devices.ingest(events);
    for (const e of events) {
      if (e.type !== HEADS_GOSSIPED || e.v !== 1) continue;
      const data = decodeHeadsGossiped(e.data);
      if (
        !data ||
        data.signer !== e.writer ||
        !this.#devices.guard.check({ device: e.writer, end: e.position }).ok ||
        !accepted(
          this.#verify,
          "cashu/gossip/v1",
          statementBody(this.#devices.ring.vaultId, e.type, e.eid, e.data),
          fromHex(data.sig),
          {
            kind: "statement",
            keys: this.#devices.registry.decisionKeys,
            device: e.writer,
            position: e.position,
            revoked: this.#devices.registry.revoked,
          },
        ) ||
        !data.heads.some((encoded) => {
          const head = decodeHead(encoded);
          return head !== undefined && this.#gossipGenuine(head);
        })
      )
        continue;
      this.#gossip.set(statementKey(e), e);
    }
    this.#refreshAttestations();
    const frozen = this.#devices.freeze(this.#freezes());
    if (frozen && frozen.rejectedFrames.length > 0) {
      this.rejections.push(...frozen.rejectedFrames);
      this.#rebuild = true;
    }
    this.#recordProofs();
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

  /** A bounded request to inspect authenticated older log history for a late same-end alternative. */
  takeHistoricalLookups(): readonly {
    readonly device: string;
    readonly end: SegmentCursor;
    readonly candidate: string;
  }[] {
    return [...this.#historicalLookups].slice(0, 4).map(([candidate, head]) => ({
      device: head.device,
      end: { seg: head.seg, offset: head.offset },
      candidate,
    }));
  }

  /** Called only after the engine scanned and authenticated its complete local log. */
  resolveHistoricalLookup(candidate: string, found: readonly string[]): void {
    const head = this.#historicalLookups.get(candidate);
    if (!head) return;
    const currentAnchor = this.#matchingAnchors.get(head.device);
    let best =
      currentAnchor && comparePositions(currentAnchor, head) < 0 ? currentAnchor : undefined;
    for (const encoded of found) {
      const other = decodeHead(encoded);
      if (!other || !this.#gossipGenuine(other)) continue;
      if (other.device !== head.device) continue;
      if (comparePositions(other, head) < 0) {
        if (!best || comparePositions(other, best) > 0) best = other;
        continue;
      }
      if (other.seg !== head.seg || other.offset !== head.offset) continue;
      if (encodeHead(other) === candidate || encodeHead(other) === encodeHead(head)) continue;
      if (this.#evidence.size >= MAX_GOSSIP_HISTORY) {
        this.#ledger.markOverflow(head.device);
        return;
      }
      const record = encodeEvidence([head, other]);
      if (!this.#evidence.has(record)) {
        this.#evidence.add(record);
        this.#newEvidence.push(record);
      }
    }
    if (best) {
      this.#matchingAnchors.set(head.device, best);
      this.heads.observe(best);
    }
    this.#historicalLookups.delete(candidate);
    this.#historicalResolved.add(candidate);
    this.#refreshAttestations();
    this.#devices.freeze(this.#freezes());
  }

  /** Historical lookup sees only admitted gossiper statements and genuine inner heads. */
  historicalHeadsInFrame(
    frame: FrameHead,
    events: readonly WireEvent[],
    device: string,
    end: SegmentCursor,
  ): readonly string[] | undefined {
    const at = { device: frame.device, end: { seg: frame.seg, offset: frame.offset } };
    const out: string[] = [];
    if (
      frame.device === device &&
      frame.stream === 1 &&
      frame.seg === end.seg &&
      frame.offset === end.offset &&
      this.#gossipGenuine(frame)
    ) {
      out.push(encodeHead(frame));
    }
    if (!this.#devices.guard.check(at).ok) {
      const previouslyAccepted = this.#devices.guard
        .entries()
        .find(([writer]) => writer === frame.device)?.[1];
      const relevant = events.some((event) => {
        if (event.t !== HEADS_GOSSIPED || event.v !== 1) return false;
        return (decodeHeadsGossiped(event.d)?.heads ?? []).some((encoded) => {
          const head = decodeHead(encoded);
          return head?.device === device && comparePositions(head, end) <= 0;
        });
      });
      if (previouslyAccepted && comparePositions(frame, previouslyAccepted) <= 0 && relevant)
        return undefined;
      return out;
    }
    for (const e of logEventsOf(frame, events)) {
      if (e.type !== HEADS_GOSSIPED || e.v !== 1) continue;
      const data = decodeHeadsGossiped(e.data);
      if (!data || data.signer !== e.writer) continue;
      const source = {
        kind: "statement" as const,
        keys: this.#devices.registry.decisionKeys,
        device: e.writer,
        position: e.position,
        revoked: this.#devices.registry.revoked,
      };
      if (
        !accepted(
          this.#verify,
          "cashu/gossip/v1",
          statementBody(this.#devices.ring.vaultId, e.type, e.eid, e.data),
          fromHex(data.sig),
          source,
        )
      )
        continue;
      for (const encoded of data.heads) {
        const head = decodeHead(encoded);
        if (
          head &&
          head.device === device &&
          comparePositions(head, end) <= 0 &&
          this.#gossipGenuine(head)
        )
          out.push(encoded);
      }
    }
    return out;
  }

  #pruneGossip(): void {
    const seen = new Map<string, string>();
    for (const [key, event] of this.#gossip) {
      const data = decodeHeadsGossiped(event.data);
      const genuine = data?.heads.filter((encoded) => {
        const head = decodeHead(encoded);
        return head !== undefined && this.#gossipGenuine(head);
      });
      if (!genuine || genuine.length === 0) {
        this.#gossip.delete(key);
        continue;
      }
      const semantic = `${event.writer}|${genuine.join(",")}`;
      const priorKey = seen.get(semantic);
      if (priorKey) {
        const prior = this.#gossip.get(priorKey);
        if (
          prior &&
          !this.#devices.guard.check({ device: prior.writer, end: prior.position }).ok &&
          this.#devices.guard.check({ device: event.writer, end: event.position }).ok
        ) {
          this.#gossip.delete(priorKey);
          seen.set(semantic, key);
        } else {
          this.#gossip.delete(key);
          continue;
        }
      } else seen.set(semantic, key);
      if (
        data?.heads.every((encoded) => {
          const head = decodeHead(encoded);
          const latest = head && this.#gossipLatest.get(head.device);
          return head && latest && comparePositions(head, latest) < 0;
        })
      ) {
        this.#gossip.delete(key);
      }
    }
    if (this.#gossip.size > MAX_GOSSIP_HISTORY) {
      while (this.#gossip.size > MAX_GOSSIP_HISTORY) {
        const oldest = this.#gossip.keys().next().value;
        if (oldest === undefined) break;
        this.#gossip.delete(oldest);
      }
    }
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
    if (head.stream === 1 && !events.every((e) => e.t === HEADS_GOSSIPED)) {
      this.#ledger.ordinary(head);
    }
    this.#refreshAttestations();
    const frozen = this.#devices.freeze(this.#freezes());
    this.#recordProofs();
    return { verdict: { ok: true }, changed: report.registryChanged || frozen !== undefined };
  }

  /** Strictly admitted gossip or source-log overflow must be visible to callers. */
  gossipStatus(): {
    readonly overflow: boolean;
    readonly pending: number;
    readonly historyPending: boolean;
    readonly authorityUncertain: boolean;
    readonly retained: number;
  } {
    const unresolvedLiveHistory = this.#historicalLookups.size > 0;
    return {
      overflow: this.#ledger.activeOverflow((device) => this.#devices.registry.isTrusted(device)),
      pending: this.gossipCandidates().length,
      historyPending: unresolvedLiveHistory,
      authorityUncertain:
        unresolvedLiveHistory ||
        this.#ledger.activeOverflow((device) => this.#devices.registry.isTrusted(device)),
      retained: this.#gossip.size,
    };
  }

  gossipCandidates(): SignedHead[] {
    const attested = this.heads
      .attestedDevices()
      .flatMap((d) => this.heads.attestations(d).filter((h) => this.#genuine(h)));
    return this.#ledger.candidates(
      this.#devices.deviceId,
      attested,
      this.heads.proofs((h) => this.#genuine(h)),
    );
  }

  prepareGossip(eid: string): ReturnType<typeof buildHeadsGossiped> | undefined {
    if (
      this.#ledger.activeOverflow((device) => this.#devices.registry.isTrusted(device)) ||
      this.#historicalLookups.size > 0 ||
      !this.#devices.registry.isTrusted(this.#devices.deviceId)
    ) {
      return undefined;
    }
    const heads = this.gossipCandidates().slice(0, 16);
    if (heads.length === 0) return undefined;
    return buildHeadsGossiped(
      this.#devices.keyContext().identity,
      this.#devices.ring.vaultId,
      eid,
      heads,
    );
  }

  #refreshAttestations(): void {
    this.heads.clearAttestations();
    // A recovery revoke accepts the target's unknown lower history. Keep proven evidence and
    // freeze floors, but stop retrying unproven lookups that cannot affect a live writer.
    for (const [encoded, head] of this.#historicalLookups) {
      if (this.#devices.registry.revoked.has(head.device)) this.#historicalLookups.delete(encoded);
    }
    const evidencedHeads = new Set<string>();
    for (const e of this.#statements.values()) {
      if (e.type !== DEVICE_REVOKED) continue;
      for (const entry of decodeDeviceRevoked(e.data)?.devices ?? []) {
        const head = entry.head === undefined ? undefined : decodeHead(entry.head);
        if (head) this.heads.attest(head);
      }
    }
    for (const record of this.#evidence) {
      for (const head of decodeEvidence(record) ?? []) {
        evidencedHeads.add(encodeHead(head));
        this.heads.attest(head);
      }
    }
    for (const head of this.#matchingAnchors.values()) this.heads.attest(head);
    for (const e of this.#gossip.values()) {
      const data = decodeHeadsGossiped(e.data);
      if (
        !data ||
        data.signer !== e.writer ||
        !this.#devices.guard.check({ device: e.writer, end: e.position }).ok
      ) {
        continue;
      }
      const source = {
        kind: "statement" as const,
        keys: this.#devices.registry.decisionKeys,
        device: e.writer,
        position: e.position,
        revoked: this.#devices.registry.revoked,
      };
      if (
        !accepted(
          this.#verify,
          "cashu/gossip/v1",
          statementBody(this.#devices.ring.vaultId, e.type, e.eid, e.data),
          fromHex(data.sig),
          source,
        )
      ) {
        continue;
      }
      for (const encoded of data.heads) {
        const head = decodeHead(encoded);
        if (!head) continue;
        if (!this.#gossipGenuine(head)) continue;
        const latest = this.#gossipLatest.get(head.device);
        const frontier = latest
          ? { seg: latest.seg, offset: latest.offset }
          : (this.heads.held(head.device) ?? this.#ledger.frontier(head.device));
        const heldAt = this.heads.headAt(head.device, { seg: head.seg, offset: head.offset });
        const relation = frontier ? comparePositions(head, frontier) : 1;
        const sameEndConflict =
          relation === 0 &&
          ((heldAt !== undefined && !equalBytes(heldAt.chain, head.chain)) ||
            (latest !== undefined && !equalBytes(latest.chain, head.chain)));
        if (
          !this.#devices.registry.revoked.has(head.device) &&
          frontier &&
          (relation < 0 || sameEndConflict) &&
          !this.#historicalResolved.has(encoded) &&
          !evidencedHeads.has(encoded) &&
          (!heldAt || !equalBytes(heldAt.chain, head.chain) || sameEndConflict)
        ) {
          if (this.#historicalLookups.size >= 64) this.#ledger.markOverflow(head.device);
          else this.#historicalLookups.set(encoded, head);
        }
        if (!latest || comparePositions(head, latest) > 0)
          this.#gossipLatest.set(head.device, head);
        if (this.#historicalLookups.has(encoded)) continue;
        this.heads.attest(head);
      }
      if (
        e.writer === this.#devices.deviceId &&
        data.heads.every((h) => {
          const head = decodeHead(h);
          return head !== undefined && this.#gossipGenuine(head);
        })
      )
        this.#ledger.receipt(data.heads);
    }
    this.#pruneGossip();
    const retained = new Set(
      [...this.#gossip.values()].flatMap((event) => decodeHeadsGossiped(event.data)?.heads ?? []),
    );
    for (const encoded of this.#historicalResolved) {
      if (!retained.has(encoded)) this.#historicalResolved.delete(encoded);
    }
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
      if (this.#evidence.size >= MAX_GOSSIP_HISTORY) {
        this.#ledger.markOverflow(pair[0].device);
        continue;
      }
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
      if (this.#evidence.size >= MAX_GOSSIP_HISTORY) {
        this.#ledger.markOverflow(pair[0].device);
        continue;
      }
      this.#evidence.add(record);
      this.#newEvidence.push(record);
    }
  }

  exportState(positions: ReadonlyMap<DeviceId, FrameHead>): string | undefined {
    const devices = this.#devices;
    if (this.#historicalLookups.size > 0) return undefined;
    try {
      return encodeGateState(
        devices.ring.vaultId,
        devices.deviceId,
        {
          positions: [...positions.values()],
          keys: this.heads.exportKeys(),
          heads: this.heads.exportHeads([
            ...devices.guard.entries(),
            ...devices.frozen.entries(),
            ...[...this.#matchingAnchors.values()].map((head): readonly [string, SegmentCursor] => [
              head.device,
              { seg: head.seg, offset: head.offset },
            ]),
          ]),
          statements: [...this.#statements.values()],
          applied: devices.guard.entries(),
          gossip: [...this.#gossip.values()],
          anchors: [...this.#matchingAnchors.values()],
          freezeFloors: [...this.#freezeFloor.entries()],
          ledger: this.#ledger.export(),
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
        for (const head of snapshot.anchors) this.#matchingAnchors.set(head.device, head);
        for (const [writer, end] of snapshot.freezeFloors) this.#freezeFloor.set(writer, end);
        for (const e of snapshot.gossip) this.#gossip.set(statementKey(e), e);
        this.#ledger.restore(snapshot.ledger);
        this.ingest(snapshot.statements);
        for (const [device, end] of snapshot.applied) devices.guard.record({ device, end });
        this.#refreshAttestations();
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

  /** A local observation for the revoke preview and final admission check. */
  checkedRevocationEntry(target: string, applied: SegmentCursor): CheckedRevocationEntry {
    const leaseFloor = this.#devices.lastLeaseEventOf(target);
    const cut = leaseFloor && comparePositions(leaseFloor, applied) > 0 ? leaseFloor : applied;
    const head = this.heads.headAt(target, cut);
    if (head && this.#genuine(head)) {
      return {
        kind: "trusted_head",
        entry: { device: target, cut, head: encodeHead(head) },
        ...(leaseFloor ? { leaseFloor } : {}),
      };
    }
    if (cut.seg !== 1 || cut.offset !== 0 || this.heads.held(target)) {
      return { kind: "integrity_error", code: "head_missing_at_non_start" };
    }
    return {
      kind: "local_start_no_head",
      entry: { device: target, cut },
      ...(leaseFloor ? { leaseFloor } : {}),
    };
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
    for (const report of this.heads.forks((h) => this.#genuine(h))) {
      const prior = this.#freezeFloor.get(report.device);
      if (!prior || comparePositions(report.agreed, prior) < 0)
        this.#freezeFloor.set(report.device, report.agreed);
    }
    return [...this.#freezeFloor.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([device, agreed]) => ({ device, agreed }));
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

  /** Gossip never treats an ambiguous certified key as a verified inner source. */
  #gossipGenuine(head: SignedHead): boolean {
    const bound = this.heads.boundKey(head.device, head.stream);
    const keys = bound ? [bound] : this.#devices.registry.authorKeys(head.device);
    if (keys.length !== 1) return false;
    return (
      acceptedHead(this.#verify, this.#devices.ring.vaultId, head, {
        kind: "author",
        keys,
      }) !== undefined
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
