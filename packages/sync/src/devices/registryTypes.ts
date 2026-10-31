// Types shared by the registry fold and its parts (revocations.ts, certificates.ts).

import type { SegmentCursor } from "../carrier.js";
import type { RecoveryPublicKeys } from "../crypto/index.js";
import type { LogEvent } from "./events.js";

/** Certificates that count per issuer (its first, by the position of its own `device.added`). */
export const MAX_CERTS_PER_ISSUER = 64;
/** Certificate signature checks per writer stream and lane issuer (bounds the work junk can cause). */
export const CERT_CHECK_BUDGET = 4 * MAX_CERTS_PER_ISSUER;
/** Revocation events that count per device signer (its first, by its own stream order). */
export const MAX_REVOCATIONS_PER_SIGNER = 64;

/** A recovery key pinned before the current one, and the old-key statements its change ratified. */
export interface PreviousRecoveryKey {
  readonly keys: RecoveryPublicKeys;
  readonly ratified: ReadonlySet<string>;
}

/** What the registry is rooted at: the vault id and the recovery keys pinned in the keyring. */
export interface TrustRoot {
  readonly vaultId: string;
  readonly recovery: RecoveryPublicKeys;
  /** Recovery keys this device pinned before (n1), oldest first. */
  readonly previous?: readonly PreviousRecoveryKey[];
}

export interface Revocation {
  readonly device: string;
  /** The effective cut: items of the device's stream ending after it are rejected (positions.ts). */
  readonly cut: SegmentCursor;
  /** Eids of the counted revocation events naming it, sorted. */
  readonly eids: readonly string[];
  /** Their signers (device ids or `RECOVERY_SIGNER_ID`), sorted, unique. */
  readonly signers: readonly string[];
  /**
   * Revoked through a revocation that only counts because the fold fails closed, or one answered by
   * a counted revocation of its own signer (mutual: never shown as a clean revocation).
   */
  readonly contested: boolean;
  /** The device's certified signing keys when it was revoked: verify its statements before the cut. */
  readonly signPublicKeys: readonly Uint8Array[];
}

export type IgnoredReason =
  | "malformed"
  | "duplicate_eid"
  | "untrusted_signer"
  | "bad_signature"
  | "after_revocation"
  | "no_effect"
  | "capped"
  | "key_mismatch"
  /** A certificate in a stream other than its issuer's (or its subject's, for a recovery-issued one). */
  | "foreign_certificate"
  /** A revocation whose batch's re-certifications are not all held yet (revoke flow). */
  | "incomplete_batch";

export interface IgnoredStatement {
  readonly eid: string;
  readonly reason: IgnoredReason;
}

export interface Decoded<T> {
  readonly event: LogEvent;
  readonly data: T;
}
