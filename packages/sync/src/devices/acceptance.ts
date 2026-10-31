// The ONE place in devices/ that checks a signature (S29c review H5'; guard:
// acceptance.guard.test.ts fails on any other call of a raw verifier in this folder).
//
// A signature counts only against a key from a named SOURCE:
// - `device`: the DECISION keys of a device under a revocation set (decisionKeys.ts, the rule);
// - `statement`: the same, limited by a revoked device's cut (Registry.statementKeys semantics);
// - `consent`: the same, minus every key whose chain needs the revocation's signer (H5');
// - `recovery`: the pinned recovery signing key (and ratified previous ones): the root itself;
// - `admission`: the subject key of the certificate being admitted (certificates.ts, self lane):
//   the closure that decision keys come from does not exist yet; the certificate itself is checked
//   against the recovery key in the same step;
// - `invite`: the inviter key the owner scanned while pairing (out of band, pairing.ts).
// Key wraps go through `unwrapFromTrusted`, whose sender keys are decision keys too.

import type { SegmentCursor } from "../carrier.js";
import {
  type DeviceIdentity,
  type Keyring,
  RECOVERY_SIGNER_ID,
  type RecoveryIdentity,
  type RecoveryPublicKeys,
  type Sodium,
  type UnwrapOptions,
  type Unwrapped,
  unwrapKeys,
  verifyWrapSignature,
  type WrapRecipient,
} from "../crypto/index.js";
import type { DecisionKeys } from "./decisionKeys.js";
import type { StatementContext, StatementVerifier } from "./statements.js";

export type KeySource =
  | { readonly kind: "device"; readonly keys: DecisionKeys; readonly device: string }
  | {
      readonly kind: "statement";
      readonly keys: DecisionKeys;
      readonly device: string;
      readonly position: SegmentCursor;
      readonly revoked: ReadonlyMap<string, { readonly cut: SegmentCursor }>;
    }
  | {
      readonly kind: "consent";
      readonly keys: DecisionKeys;
      readonly device: string;
      /** The revocation's signer: its certificates (and all below them) never back the consent. */
      readonly avoid: string;
    }
  | { readonly kind: "recovery"; readonly signKeys: readonly Uint8Array[] }
  | { readonly kind: "admission"; readonly signKey: Uint8Array }
  | { readonly kind: "invite"; readonly signKey: Uint8Array };

function keysOf(source: KeySource): readonly Uint8Array[] {
  switch (source.kind) {
    case "device":
      return source.keys.signKeysOf(source.device);
    case "statement":
      return source.keys.statementKeys(source.device, source.position, source.revoked);
    case "consent":
      return source.keys.keysAvoiding(source.device, source.avoid).map((k) => k.signPublicKey);
    case "recovery":
      return source.signKeys;
    case "admission":
    case "invite":
      return [source.signKey];
  }
}

/** The key of `source` the signature verifies with, or undefined. */
export function acceptedKey(
  verify: StatementVerifier,
  context: StatementContext,
  body: Uint8Array,
  signature: Uint8Array,
  source: KeySource,
): Uint8Array | undefined {
  return keysOf(source).find((k) => verify(context, body, signature, k));
}

/** True when the signature verifies with a key of `source`. */
export function accepted(
  verify: StatementVerifier,
  context: StatementContext,
  body: Uint8Array,
  signature: Uint8Array,
  source: KeySource,
): boolean {
  return acceptedKey(verify, context, body, signature, source) !== undefined;
}

/** A recovery-signed key wrap (a recovery change's base wrap) under the given recovery key. */
export function acceptedRecoveryWrap(
  wire: Uint8Array,
  vaultId: string,
  recipient: WrapRecipient,
  recoverySignKey: Uint8Array,
): boolean {
  return verifyWrapSignature(wire, vaultId, recipient, RECOVERY_SIGNER_ID, recoverySignKey);
}

/** Opens a key wrap whose sender must be the recovery identity or hold a trusted decision key. */
export function unwrapFromTrusted(
  sodium: Sodium,
  wire: Uint8Array,
  recipient: DeviceIdentity | RecoveryIdentity,
  target: Keyring | { vaultId: string; recoveryPublicKey: RecoveryPublicKeys },
  keys: DecisionKeys,
  recoverySignKey: Uint8Array,
  options: UnwrapOptions,
): Unwrapped {
  return unwrapKeys(
    sodium,
    wire,
    recipient,
    target,
    (id) => (id === RECOVERY_SIGNER_ID ? recoverySignKey.slice() : keys.trustedKeyOf(id)),
    options,
  );
}
