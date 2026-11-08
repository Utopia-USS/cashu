// The public contract of a native vault session, re-exported unchanged by ../nativeVault.ts.
import type {
  DeviceListResult,
  RevokeCommitResult,
  RevokeInspectResult,
} from "@cashu/host-protocol";
import type { LanCarrierReply, LanCarrierRequest } from "@cashu/host-protocol/pairing-lan";
import type { Store } from "@cashu/store";
import type { crypto, devices, SyncEngine, SyncResult, Transport } from "@cashu/sync";
import type { SqlAttemptJournal } from "../attemptJournal.js";
import type { NativeBlobPublication } from "../nativeBlobs.js";
import type { PairingReads } from "../pairing/readCapability.js";
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

export interface NativeVaultSession extends PairingReads {
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
  pairingAppend(input: {
    readonly session: string;
    readonly operationId: string;
    readonly welcome: devices.InviterWelcome;
    readonly authority: string;
    readonly qr: string;
    readonly rendezvous: string;
  }): Promise<"completed" | "outcome_unknown" | "refused">;
  carrierRequest(
    request: LanCarrierRequest,
    expiresAt: number,
    onAuthorized?: () => void,
  ): Promise<LanCarrierReply>;
  invalidate(): void;
  close(): Promise<void>;
}
