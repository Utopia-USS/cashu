// The sync carrier contract (S28a). Decision: own thin log (spike-result.md). The domain side
// (store, S23) never sees transports, segments or crypto: it hands batches to `SyncEngine.write` and
// receives batches through `EventSink.apply`.
//
// Model
// - A vault (= one profile) has a log: per-device, append-only segments `<vault>/<device>/<seg>`,
//   numbered from 1, one writer each (the device itself). Segments hold frames:
//   `u32 big-endian length | sealed bytes` where the sealed bytes come from the `FrameCodec`
//   (compression + XChaCha20-Poly1305 in S27/S28b) bound to the frame position (the AAD).
// - Each device keeps a full local copy of the log in its `local` transport (own segments are written
//   there first, so writes work offline) and replicates with zero or more `remotes` (synced folder,
//   relay) on `sync()`: own bytes are pushed by offset, foreign frames are pulled after the codec
//   opened them and the `FrameGate` verified their signed heads, so the local copy only ever holds
//   frames that open and that their writer signed (S29c phase B2).
// - Every frame ends with its writer's signed head over the writer's hash chain (crypto/head.ts):
//   the codec computes the chain from the previous frame's (`prev`), the gate checks the signature
//   with the registry's keys (devices/gate.ts) and decides whether the frame's data is accepted.
// - A cursor per device segment stream says how far the view has applied. The sink persists it in the
//   same transaction as the batch, so a crash re-delivers (at least once) and the sink's idempotency
//   by `eid` (events.md 2) makes that harmless.
import type { ClockWarning, Hlc, HlcState } from "./hlc.js";

export type Awaitable<T> = T | Promise<T>;

/** Opaque routing id of a vault (S27: 16 random bytes in hex; never the profile slug). */
export type VaultId = string;
/** 32 lower-case hex (S27 `DeviceIdentity`, crypto `assertDeviceId`), minted at pairing (S29). */
export type DeviceId = string;

/**
 * An event in wire form (events.md 2.1): `t` type, `v` version, `h` HLC, `i` eid, `d` payload, plus
 * `g` gid, `a` at, `c` cause, `o` origin and any key a newer writer adds. The engine reads only
 * `t`, `v`, `h`, `i` and `d`; everything else passes through untouched (forward compatibility).
 * Vault and device are implied by the segment.
 */
export interface WireEvent {
  readonly t: string;
  readonly v: number;
  readonly h: Hlc;
  readonly i: string;
  readonly d: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** What a command hands to `write`: a wire event without the HLC, which the engine stamps. */
export interface UnstampedEvent {
  readonly t: string;
  readonly v: number;
  readonly i: string;
  readonly d: Readonly<Record<string, unknown>>;
  readonly h?: never;
  readonly [key: string]: unknown;
}

/** Position of the next unread frame in one device's segment stream. */
export interface SegmentCursor {
  readonly seg: number;
  readonly offset: number;
}

export const START_CURSOR: SegmentCursor = { seg: 1, offset: 0 };

// ---------------------------------------------------------------------------------------------
// Domain side

/** One atomic batch for the view: one frame, or a whole frame group (events.md 5). */
export interface InboundBatch {
  readonly vault: VaultId;
  readonly device: DeviceId;
  /** True for this device's own events (applied through the same path as remote ones). */
  readonly own: boolean;
  /** Strictly increasing `h`, in the writer's order. */
  readonly events: readonly WireEvent[];
  /** Where the stream continues after this batch. Persist it in the same transaction. */
  readonly cursor: SegmentCursor;
}

export interface ApplyOutcome {
  /** Events that changed (or were folded into) the view. */
  readonly applied: number;
  /** Events whose `eid` was applied before (re-delivery): no-op. */
  readonly duplicates: number;
  /** Events stored but not applied: unknown type, newer `v`, failed validation (events.md 7). */
  readonly parked: number;
}

/**
 * The store side of the engine (S23 implements it over SQLite: materializers + `applied_events` +
 * a cursor table). The engine guarantees per-device order and at-least-once delivery; the sink
 * guarantees idempotency by `eid` and order independence across devices.
 */
export interface EventSink {
  /** Cursors persisted with the view (missing device = start of its stream). */
  cursors(): Awaitable<ReadonlyMap<DeviceId, SegmentCursor>>;
  /**
   * Apply `batches` in order, in ONE transaction, persisting every batch's `cursor` with it: all of
   * them or none (S29c-B3: one transaction per sync pull, chunked by the engine). The outcome of each
   * batch is the one a sequential apply would give. A throw means nothing was applied.
   */
  applyBatches(batches: readonly InboundBatch[]): Awaitable<readonly ApplyOutcome[]>;
  /** Existing parked events behind a persisted cursor, when the sink can report them. */
  needsUpgrade?(): Awaitable<boolean>;
  /** Drop the view, parked events and cursors (rebuild, events.md 7.9). */
  reset(): Awaitable<void>;
}

/** Durable clock state per device and vault (S23 keeps it in the view DB meta table). */
export interface ClockStore {
  load(): Awaitable<HlcState | undefined>;
  save(state: HlcState): Awaitable<void>;
}

/**
 * Durable snapshot of the frame gate's state per device and vault (S29c-B3; the store keeps it in its
 * meta table). Opaque text the gate produced and authenticates itself (`FrameGate.exportState`).
 */
export interface GateStateStore {
  load(): Awaitable<string | undefined>;
  save(state: string): Awaitable<void>;
  /** The gate's append-only evidence record (proven forks), never rolled back with the snapshot. */
  loadEvidence?(): Awaitable<readonly string[]>;
  appendEvidence?(records: readonly string[]): Awaitable<void>;
}

// ---------------------------------------------------------------------------------------------
// Carrier side

/** Where a frame sits; the codec binds the sealed bytes to it (AAD). `offset` = start of the length prefix. */
export interface FramePosition {
  readonly vault: VaultId;
  readonly device: DeviceId;
  readonly seg: number;
  readonly offset: number;
}

/**
 * A frame's signed head (crypto `SignedHead`, structurally): the writer's statement about its stream
 * `stream` (0 = the carrier's manifest, segment 0; 1 = data) up to `seg:offset`, the cursor after the
 * frame, with the hash chain over every frame before it and the writer's Ed25519 signature.
 */
export interface FrameHead {
  readonly device: DeviceId;
  readonly stream: 0 | 1;
  readonly seg: number;
  readonly offset: number;
  readonly chain: Uint8Array;
  readonly sig: Uint8Array;
}

/**
 * Seam for compression + authenticated encryption + the writer's signature (S27 `sealFrame` /
 * `openFrame` v3, wrapped by S28b). `prev` is the chain of the writer's previous frame in the same
 * stream (`genesis` before the first). `open` MUST throw (preferably a `FrameRejectedError` or an
 * error with a string `code`) when the bytes were changed, truncated, sealed with another key or for
 * another position, and must never return partial plaintext; the head it returns carries the
 * frame's signature UNVERIFIED (the `FrameGate` checks it with the writer's keys).
 */
export interface FrameCodec {
  /** Seals as this codec's own device (the writer of `at`); throws for another writer. */
  seal(
    plain: Uint8Array,
    at: FramePosition,
    prev: Uint8Array,
  ): Awaitable<{ readonly sealed: Uint8Array; readonly head: FrameHead }>;
  open(
    sealed: Uint8Array,
    at: FramePosition,
    prev: Uint8Array,
  ): Awaitable<{ readonly plain: Uint8Array; readonly head: FrameHead }>;
  /** The chain after a frame, from its bytes alone (no decryption): rebuilds chains of a stored log. */
  link(sealed: Uint8Array, at: FramePosition, prev: Uint8Array): Uint8Array;
  /** The chain before the first frame of `device`'s stream (`stream` 0: manifest, 1: data). */
  genesis(vault: VaultId, device: DeviceId, stream: 0 | 1): Uint8Array;
}

/** A gate decision; `wait`: not decidable yet (writer unknown), retried after the next change. */
export type GateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly wait: boolean; readonly code: string };

/**
 * The device layer as the engine and the carrier see it (devices/gate.ts implements it over the
 * registry). Signatures are checked here, never by the codec, because only the registry knows which
 * keys a writer has.
 */
export interface FrameGate {
  /** One bounded authenticated gossip event, or undefined when there is no new eligible head. */
  prepareGossip?(eid: string): UnstampedEvent | undefined;
  /** Visible capacity/status report; overflow must not be mistaken for a fully shared frontier. */
  gossipStatus?(): {
    readonly overflow: boolean;
    readonly pending: number;
    readonly historyPending: boolean;
    readonly authorityUncertain: boolean;
  };
  takeHistoricalLookups?(): readonly {
    readonly device: DeviceId;
    readonly end: SegmentCursor;
    readonly candidate: string;
  }[];
  historicalHeadsInFrame?(
    frame: FrameHead,
    events: readonly WireEvent[],
    device: DeviceId,
    end: SegmentCursor,
  ): readonly string[] | undefined;
  resolveHistoricalLookup?(candidate: string, found: readonly string[]): void;
  /**
   * Whether `head` (just opened, chain recomputed by the codec) was signed by its writer. `events`
   * are the frame's decoded events (empty for manifest records or an unreadable payload): a stream's
   * first frame may introduce its writer with the recovery-issued certificate it carries.
   */
  authenticate(head: FrameHead, events: readonly WireEvent[]): GateVerdict;
  /**
   * A verified data frame, in its writer's stream order: ingests its statements (`device.*`,
   * `lease.*`) and decides whether its DATA is accepted (revocation cut, fork freeze).
   * `changed`: the registry changed, so frames that waited may verify now.
   */
  accept(
    head: FrameHead,
    events: readonly WireEvent[],
  ): { readonly verdict: GateVerdict; readonly changed: boolean };
  /** A verified data frame's statements only (the engine's replay after start, before any data). */
  observe(head: FrameHead, events: readonly WireEvent[]): void;
  /**
   * True when the gate keeps state built from statements (a registry) that it does not have yet:
   * the engine then walks the whole local log through `accept` once after start (without
   * re-delivering data). A stateless gate returns false.
   */
  needsReplay(): boolean;
  /** True once data the view holds is no longer accepted (D8): rebuild. Reading it clears it. */
  takeRebuild(): boolean;
  /** Forget which data was accepted (the engine resets the sink and replays the log next). */
  reset(): void;
  /**
   * Persistence of a gate with statement state (S29c-B3, optional): its state after it judged every
   * frame up to `positions` (per writer, the head of the last data frame it accepted, in stream
   * order), as text the gate authenticates (signed by this device). Undefined: not exportable now.
   */
  exportState?(positions: ReadonlyMap<DeviceId, FrameHead>): string | undefined;
  /**
   * Checks an exported state without changing the gate: undefined when it does not authenticate
   * (corrupt, forged, another device or vault) or a position's head is not signed by the key its
   * stream is bound to. Otherwise its positions, which the engine checks against the local log
   * (chains and signatures of the frames there) before it calls `restore`; it then replays only the
   * frames after them.
   */
  importState?(state: string):
    | {
        readonly positions: ReadonlyMap<DeviceId, FrameHead>;
        /** Heads this device previously held locally, as recorded in its signed snapshot. */
        readonly heldHeads?: readonly FrameHead[];
        /** Signed legacy state anchors the local log but must replay all frames. */
        readonly replayOnly?: boolean;
        restore(): void;
      }
    | undefined;
  /** Writers in authenticated fork evidence, for recovery reporting only. */
  recoveryEvidenceDevices?(): readonly DeviceId[];
  /** Evidence (proven forks) found since the last call: the engine appends it to its record. */
  takeEvidence?(): readonly string[];
  /** The evidence record, restored after a start before the snapshot and any replay. */
  importEvidence?(records: readonly string[]): void;
}

export interface SegmentInfo {
  readonly device: DeviceId;
  readonly seg: number;
  readonly size: number;
}

/**
 * What a transport promises about when an `append` becomes visible to `list` / `read` calls through
 * OTHER handles (other devices). Declared by the transport author from the backend's documented
 * guarantee, never inferred at runtime; the fetch lease relies on it (devices/lease.ts, rule 6):
 * - `linearizable`: visible to every call that starts after the `append` resolved (memory, one local
 *   directory no sync tool touches, a single relay process with read-after-write storage);
 * - `bounded`: visible to every call that starts at least `propagationMs` after the `append`
 *   resolved (a relay whose storage replicates with a documented bound). A transport may declare it
 *   only when `checkPropagationClaim` (testing/propagation.ts, part of the contract suite) passes
 *   for it: the claim is tested, not assumed;
 * - `eventual`: no bound (iCloud Drive, Syncthing, Dropbox, any synced folder).
 */
export type TransportConsistency =
  | { readonly kind: "linearizable" }
  | { readonly kind: "bounded"; readonly propagationMs: number }
  | { readonly kind: "eventual" };

/** The propagation bound of a declaration in ms (linearizable = 0), or undefined for `eventual`. */
export function propagationBound(c: TransportConsistency): number | undefined {
  if (c.kind === "linearizable") return 0;
  if (c.kind === "bounded") {
    return Number.isSafeInteger(c.propagationMs) && c.propagationMs >= 0
      ? c.propagationMs
      : undefined;
  }
  return undefined;
}

/**
 * Moves opaque bytes: a local log directory, a synced folder (iCloud Drive / Syncthing, S28c) or a
 * blind relay (S28d). Segments are append-only and have one writer each.
 */
export interface Transport {
  /** REQUIRED: what the backend promises about visibility to other devices (see the type). */
  readonly consistency: TransportConsistency;
  /** Every segment of the vault with its current size. Order is not significant. */
  list(vault: VaultId): Promise<readonly SegmentInfo[]>;
  /** Bytes of a segment from `fromOffset` to its current end (empty when past the end or unknown). */
  read(vault: VaultId, device: DeviceId, seg: number, fromOffset: number): Promise<Uint8Array>;
  /**
   * Append at `atOffset`, which MUST equal the segment's current size (0 creates it); otherwise
   * reject with `TransportError("offset-conflict")` and write nothing. All or nothing.
   */
  append(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    atOffset: number,
    bytes: Uint8Array,
  ): Promise<void>;
  /** Change notification (another writer appended). Optional: callers fall back to polling. */
  watch?(vault: VaultId, onChange: () => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Engine

export interface RejectedFrame {
  readonly device: DeviceId;
  readonly seg: number;
  readonly offset: number;
  /** Codec code (tamper, wrong key, ...) or `malformed` / `too-large` / `frame-format`. */
  readonly code: string;
}

export interface WriteResult {
  readonly events: number;
  readonly frames: number;
  /** HLC of the first and last stamped event. */
  readonly first: Hlc;
  readonly last: Hlc;
}

export interface WriteOptions {
  /** Folded view high-water mark to receive inside the engine's serialized write. */
  readonly afterHlc?: Hlc;
}

export type LocalRecoveryDisposition =
  | "authenticated_accepted"
  | "authenticated_suppressed"
  | "authenticated_parked"
  | "unresolved_tail";

export interface LocalStreamRecovery {
  readonly device: DeviceId;
  readonly inspectedThrough: SegmentCursor;
  readonly heldEnd: SegmentCursor;
  readonly appliedThrough: SegmentCursor;
  /** Accepted means the sink cursor is sound, not that domain materialization changed the view. */
  readonly disposition: LocalRecoveryDisposition;
  /** Value-free reason for the first unresolved position. */
  readonly reason?: string;
}

export interface LocalRecoveryResult {
  readonly complete: boolean;
  readonly streams: readonly LocalStreamRecovery[];
  /** Null when an opaque sink cannot report previously parked events. */
  readonly needsUpgrade: boolean | null;
  readonly requiresViewRebuild: boolean;
  readonly rolledBack: boolean;
}

export interface SyncResult {
  /** Own gossip receipt is durable locally; remote delivery may still be pending. */
  readonly gossip?: {
    readonly emitted: boolean;
    readonly deliveryPending: boolean;
    readonly overflow: boolean;
    readonly pendingHeads: number;
    readonly historyPending: boolean;
    readonly ownTailUncertain: boolean;
  };
  /** True when the pass rebuilt the view because data it held was no longer accepted (D8). */
  readonly rebuilt: boolean;
  /** Own bytes pushed to remotes. */
  readonly pushedBytes: number;
  /** Foreign frames verified and copied into the local log. */
  readonly pulledFrames: number;
  /** Batches handed to the sink. */
  readonly batches: number;
  readonly applied: number;
  readonly duplicates: number;
  readonly parked: number;
  /** True when this pass parked events or met a frame format it cannot read: upgrade the app. */
  readonly needsUpgrade: boolean;
  /** Remotes that could not be reached in this pass. */
  readonly offlineRemotes: number;
  /**
   * Frames that did not open, parse or verify (or whose writer is not known yet: `writer-unknown`);
   * that device's stream waits at the frame (retried next pass).
   */
  readonly rejected: readonly RejectedFrame[];
  readonly clockWarnings: readonly ClockWarning[];
  /** A remote holds more of this device's own log than the local copy: writes are refused. */
  readonly rolledBack: boolean;
}

export interface AppliedInfo {
  readonly types: ReadonlySet<string>;
  readonly events: number;
}

/**
 * What the last sync pass proved about this device's remotes, for the fetch lease's automatic mode
 * (devices/lease.ts `LeaseLocal.transport`). `bounded` only when the engine has at least one remote
 * declaring a propagation bound and EVERY such remote was reachable in the last pass; then
 * `propagationMs` is the largest bound, `lastPullAt` the earliest start of that pass's pulls through
 * them and `lastPushAt` the latest completion of its pushes (physical clock of the engine). A device
 * whose relay is offline is `eventual` for that pass.
 */
export type LeaseTransport =
  | {
      readonly kind: "bounded";
      readonly propagationMs: number;
      readonly lastPullAt: number;
      readonly lastPushAt: number;
    }
  | { readonly kind: "eventual" };

export interface SyncEngine {
  readonly vault: VaultId;
  readonly device: DeviceId;
  /** Read-only authority and own-tail admission for side effects before an engine write. */
  writeAdmission(): "ready" | "own-tail-uncertain" | "authority-unresolved" | "rolled-back";
  /** The lease transport report of the last `sync()` pass (`eventual` before the first one). */
  leaseTransport(): LeaseTransport;
  /** Stamp, append to the own segment as one atomic batch (frame or frame group), apply locally. */
  write(events: readonly UnstampedEvent[], options?: WriteOptions): Promise<WriteResult>;
  /** Authenticated exact own one-frame batch proof for a private prepared-attempt journal. */
  inspectOwnBatch(expected: {
    readonly eids: readonly string[];
    readonly digest: string;
  }): Promise<"committed" | "absent" | "unknown">;
  /** Audit and replay the held local log without network access or a destructive view reset. */
  recoverLocal(): Promise<LocalRecoveryResult>;
  /** Push own bytes, pull and verify foreign frames, apply everything new. */
  sync(): Promise<SyncResult>;
  /** Reset the sink and replay the whole local log (schema change, app upgrade). */
  rebuild(): Promise<SyncResult>;
  /** Called after a pass applied events (UI re-query trigger). Returns the unsubscribe function. */
  onApplied(listener: (info: AppliedInfo) => void): () => void;
  close(): Promise<void>;
}
