// The verified-prefix checkpoint of a native vault's local log (engine option `recoveryCheckpoint`,
// packages/sync carrier.ts), the same one the phone keeps. Without it every host start, and the replay
// after every sync pass, opened and re-verified the whole log; with it they verify only the frames
// written since the last complete audit.
//
// It lives in the vault's private metadata DB (`private.db`, WAL + synchronous FULL), next to the log
// folder it vouches for and inside the same vault directory, and is signed by this device on top, so a
// write to the database alone cannot mint one. The engine treats it as an optimization it distrusts:
// a bad signature, another key ring (`binding`), a changed log prefix or view cursor, fork evidence,
// or a tail with a registry or key statement clears it and the whole log is replayed as before.
import type { SqlDriver } from "@cashu/store";
import { SqlRecoveryCheckpointStore } from "@cashu/store/sync";
import { crypto, type RecoveryCheckpointOptions } from "@cashu/sync";

const CONTEXT = "cashu/checkpoint/v1";

export function nativeRecoveryCheckpoint(
  meta: SqlDriver,
  authority: {
    readonly deviceId: string;
    readonly ring: crypto.Keyring;
    readonly identity: crypto.DeviceIdentity;
  },
): RecoveryCheckpointOptions {
  const { identity, ring } = authority;
  return {
    store: new SqlRecoveryCheckpointStore(meta, authority.deviceId),
    binding: () => ringFingerprint(ring),
    sign: (body) => identity.sign(CONTEXT, body),
    verify: (body, signature) =>
      crypto.verifyContextSignature(CONTEXT, body, signature, identity.signPublicKey),
  };
}

/**
 * What a checkpoint is bound to of the key ring: its key ids (a key never changes once held) and the
 * pinned recovery public keys. A rotation or a recovery change gives another value, which discards the
 * checkpoint. Public facts only.
 */
function ringFingerprint(ring: crypto.Keyring): string {
  const kids = ring
    .entries()
    .map((entry) => entry.kid)
    .sort();
  const { recovery } = ring;
  return `${kids.join(",")}|${hex(recovery.boxPublicKey)}|${hex(recovery.signPublicKey)}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
