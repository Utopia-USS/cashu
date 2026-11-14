// The public contract of a native vault session, re-exported unchanged by ../nativeVault.ts.
import type {
  DeviceListResult,
  RevokeCommitResult,
  RevokeInspectResult,
} from "@cashu/host-protocol";
import type { Store } from "@cashu/store";
import type { crypto, devices, PullHistory, SyncEngine, SyncResult, Transport } from "@cashu/sync";
import type { SqlAttemptJournal } from "../attemptJournal.js";
import type { NativeBlobPublication } from "../nativeBlobs.js";
import type { PairingAttempt } from "../pairing/journal.js";
import type { StrategyDirectoryAuthority } from "../proposals/strategyFiles.js";
import type { WriteQueue } from "../queue.js";
import type { NativeVaultInventoryEntry } from "../sync/keys/deviceAuthority.js";

export interface NativeVaultSource {
  /** Candidate locators from the host-owned inventory, globally checked before opening. */
  readonly inventory: readonly NativeVaultInventoryEntry[];
  /** Exact namespace and data-dir bound provider. T44 supplies the production factory. */
  readonly keyStore: crypto.KeyStore;
  readonly sodium: crypto.Sodium;
  /** Authenticated creation/pairing certificate artifacts for this exact vault. */
  bootstrapCertificates(entry: NativeVaultInventoryEntry): Promise<readonly Uint8Array[]>;
  /** Explicit bound, manifest-gated carrier transports. Absence is offline local-only operation. */
  remoteTransports?(entry: NativeVaultInventoryEntry): readonly Transport[];
  /**
   * The vault's persisted sync history (G2 / G5: last complete pull, pause start) for the engine;
   * absent: none kept (the engine starts without one).
   */
  pullHistory?(entry: NativeVaultInventoryEntry): PullHistory | undefined;
  /**
   * G2: a device's kind as the vault's relay membership knows it (`admin` a Mac, `member` a phone),
   * read live; undefined (or absent): unknown, and the lease treats that device as one that could lead.
   */
  relayRole?(entry: NativeVaultInventoryEntry, device: string): "admin" | "member" | undefined;
  /**
   * G2 override: when the owner acknowledged the offline bound for this vault ("keep fetching on this
   * Mac"), read live; undefined (or absent): never, or cleared by a complete pull since.
   */
  offlineLeadAck?(entry: NativeVaultInventoryEntry): number | undefined;
  /** S6 tests: own bytes one pass pushes at most (`SyncEngineOptions.maxPushBytesPerPass`). */
  readonly maxPushBytesPerPass?: number;
}

export interface NativeDeviceRevokeDraft {
  readonly vault: string;
  readonly targets: readonly string[];
  readonly recertify: readonly string[];
  readonly operationId: string;
  readonly eids: { readonly revoke: string; readonly rotate: string };
  readonly fingerprint?: string;
}

type NativeDevicePreviewResult =
  | {
      readonly kind: "prepared";
      readonly fingerprint: string;
      readonly targets: readonly {
        readonly device: string;
        readonly cut: { readonly seg: number; readonly offset: number };
        readonly head: "trusted" | "local_start";
      }[];
      readonly affected: readonly {
        readonly device: string;
        readonly name: string;
        readonly selected: boolean;
      }[];
      readonly localStartConfirmationRequired: boolean;
    }
  | {
      readonly kind: "refused";
      readonly code:
        | "unsafe_target"
        | "retirement_unavailable"
        | "integrity_failure"
        | "outcome_unknown"
        | "unavailable";
    };

/**
 * Why this device may not fetch right now, for worker and host status (nativeVault/fetchAuthority.ts);
 * null when it may, or would after a refresh.
 */
export type FetchAuthorityIssue =
  | "fetch_session_unavailable"
  | "fetch_not_leader"
  | "fetch_handover_pending"
  | "fetch_clock_suspect"
  | "fetch_pull_failed"
  | "fetch_pull_incomplete"
  | "fetch_authority_unavailable";

export interface NativeVaultSession {
  readonly id: string;
  readonly store: Store;
  readonly engine: SyncEngine;
  readonly attempts: SqlAttemptJournal;
  readonly queue: WriteQueue;
  readonly device: string;
  readonly epoch: object;
  isCurrent(): boolean;
  /** Authenticated exact-session authority for workspace files; invalid after reopen/recovery. */
  workspaceAuthority(): {
    readonly vault: string;
    readonly generation: string;
    isCurrent(): boolean;
  } | null;
  /** Read/pull may continue while this denies new writes and external effects. */
  canRunSideEffects(): boolean;
  /** Call only inside the durable command queue, before the merge's may-append intent. */
  createMergeCheckpoint(): Promise<void>;
  checkpointDirectory(): string;
  strategyDirectoryAuthority(): StrategyDirectoryAuthority | null;
  canFetchPublicMarket(): boolean;
  /**
   * Obtains fresh pull evidence through `sync()` when this device is the named fetch leader and the
   * evidence is missing or stale, then answers `canFetchPublicMarket()` (nativeVault/fetchAuthority).
   * Call it before a leader action and between the steps of a long one; never inside the queue.
   */
  refreshFetchAuthority(): Promise<boolean>;
  /** Fetch authority now, or after the pull `refreshFetchAuthority` would run (status reports). */
  mayObtainFetchAuthority(): boolean;
  /** Why this device may not fetch now (null: it may, or would after a refresh), for status. */
  fetchAuthorityIssue(): FetchAuthorityIssue | null;
  /** A live external fetch holds back non-force leader handover ACK until it settles. */
  beginFetch(): (() => void) | null;
  /** Separate durable lease report after a successful checked fetch. */
  recordFetch(): Promise<"completed" | "not_started" | "outcome_unknown">;
  /** Exact-vault encrypted import archive, invalidated with this native session. */
  blobPublication(): NativeBlobPublication | null;
  isSyncing(): boolean;
  onSyncSettled(listener: () => void): () => void;
  /** Fires after anything the device list shows may have changed: a sync pass settled (or the session closed), a
   * revocation or leader pin committed or was inspected, a pairing appended. */
  onDevicesChanged(listener: () => void): () => void;
  /**
   * A pairing transition the device list cannot see on its own (a phone connected, an invitation
   * ended, an admission settled, the phone's first sync arrived): bumps the list's `pairingRevision`
   * and fires `onDevicesChanged`, so the pushed list changes and a pairing screen asks again.
   */
  pairingChanged(): void;
  /** Fires after every committed local append of this device (the relay schedules its push). */
  onLocalWrite(listener: () => void): () => void;
  /** Serialize inbound fold and push with UI commands on this vault. */
  sync(): Promise<SyncResult>;
  deviceList(): Promise<DeviceListResult>;
  devicePreview(draft: NativeDeviceRevokeDraft): Promise<NativeDevicePreviewResult>;
  deviceCommit(
    draft: NativeDeviceRevokeDraft,
    input: {
      readonly warningAcknowledgement: "revoke_risk_acknowledged";
      readonly localStartAcknowledgement?: "local_target_stream_never_seen";
      readonly recoveryPhrase: string;
    },
  ): Promise<RevokeCommitResult>;
  deviceInspect(operationId: string): Promise<RevokeInspectResult>;
  leaderPrepare(
    leader: string,
    force: boolean,
  ): Promise<
    | {
        readonly kind: "prepared";
        readonly head: string;
        readonly mayStillRun: string | null;
        readonly confirmationText: string;
      }
    | { readonly kind: "refused"; readonly code: "unavailable" | "unsafe_target" }
  >;
  leaderCommit(
    leader: string,
    force: boolean,
    confirmationText: string,
    head: string,
    operationId: string,
  ): Promise<"completed" | "not_started" | "outcome_unknown">;
  leaderInspect(
    operationId: string,
  ): Promise<"completed" | "not_started" | "outcome_unknown" | "not_found">;
  pairingStart(
    rendezvous: string,
  ): Promise<
    | devices.PairingStep<{ inviter: devices.PairingInviter; qr: string; authority: string }>
    | { ok: false; reason: "unavailable" }
  >;
  pairingRegisterInvite(
    session: string,
    operationId: string,
    qr: string,
    expiresAt: number,
  ): Promise<boolean>;
  pairingBindJoiner(
    session: string,
    joiner: {
      readonly deviceId: string;
      readonly signPublicKey: Uint8Array;
      readonly boxPublicKey: Uint8Array;
    },
  ): Promise<boolean>;
  /**
   * Admits the joiner (pairing/service.ts): every refusable check, `membership.preflight` (the relay
   * answers), a durable `admitting` row, `membership.admit` (the joiner's relay membership: the ONE
   * commit point), then the keyed `device.added` append, pushed once. `refused`: nothing was admitted
   * (no membership written, or provably none). `outcome_unknown`: the membership or the append has no
   * known outcome; the row converges (`pairingResolve`, `pairingResume`), never to a refusal after
   * the membership exists.
   */
  pairingAdmit(
    input: {
      readonly session: string;
      readonly operationId: string;
      readonly welcome: devices.InviterWelcome;
      readonly authority: string;
      readonly qr: string;
      /** The joiner's relay uid (bound at its hello). */
      readonly uid: string;
    },
    membership: {
      /** Throws when the relay cannot be reached (nothing is journalled then). */
      preflight(): Promise<void>;
      /** Writes the membership: `absent` only when it provably was not written. */
      admit(): Promise<"admitted" | "absent" | "unknown">;
    },
  ): Promise<"completed" | "outcome_unknown" | "refused">;
  /**
   * For the relay reconciliation: which of `members` (device ids) the registry holds, and the live
   * admission rows (`admitting`, `may_append`). Undefined when the session is not current.
   */
  pairingAdmissions(members: readonly string[]): Promise<
    | {
        readonly registered: ReadonlySet<string>;
        readonly live: readonly {
          readonly session: string;
          readonly device: string;
          readonly phase: PairingAttempt["phase"];
          readonly uid?: string;
          readonly touchedAt?: number;
        }[];
      }
    | undefined
  >;
  /**
   * Resolves an `admitting` row from a relay member list read at `listedAt`: `present` drives it on
   * (the append), `absent` ends it `not_started` only when the list was read after the write ended.
   */
  pairingResolve(
    session: string,
    membership: "present" | "absent",
    listedAt: number,
  ): Promise<void>;
  /** Retries every owed append (`may_append`): at open and after each relay pass. */
  pairingResume(): Promise<void>;
  /**
   * The keyed pairing attempt of `operationId`, a pending one settled from the log first;
   * `joinerSeen`: the joiner's first signed head is in this Mac's log (it synced once).
   */
  pairingOperation(
    operationId: string,
  ): Promise<(PairingAttempt & { readonly joinerSeen: boolean }) | undefined>;
  invalidate(): void;
  close(): Promise<void>;
}
