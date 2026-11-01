// "Recovery key changed" (crypto README n1): the owner replaces the 24 recovery words without
// creating a new vault, for example after the old words leaked.
//
// A trusted device writes `device.recoveryChanged` (signed by itself, writer = signer, and
// authorized by the OLD recovery identity: the owner types the old words once more) naming the
// recovery keys it replaces (`from`) and the new ones (`to`), with:
// - a new base wrap: the whole ring as of the change, pinned to the new keys, signed by the NEW
//   recovery identity and sealed for its box key (the new words seed a restore from it, exactly like
//   `createVaultWithRecovery`'s wrap);
// - certificates by the new recovery identity for every device trusted at the change (trust is
//   rooted at the recovery key, so chains to the old key end with the change);
// - the eids of the registry statements signed with the old words that the changer had accepted.
//
// Each device pins the new keys LOCALLY (`Keyring.replaceRecoveryKey`) when it applies a change whose
// `from` is its current pin, whose authorization the pinned (old) recovery key signed, whose signer
// was trusted when it wrote it (before any cut) and whose base wrap verifies under the new keys.
// Requiring both the old words and a trusted device means a stolen device cannot move the trust root
// to words its thief holds (which would make every later revocation of it worthless), and leaked old
// words alone cannot either. From then on its registry is rooted at the new key; statements signed with the old
// words count only when ratified, so a leaked old phrase can neither revoke devices nor certify new
// ones. A device pinned to the new keys ignores any later change that starts from the old ones (a
// thief with the old words can certify a puppet under the old root and publish a competing change,
// but no device that applied the owner's change follows it). Two competing changes from the key a
// device is pinned to are not applied (fail closed, reported): the owner re-pairs that device.

import type { UnstampedEvent } from "../carrier.js";
import {
  certifyDevice,
  type DeviceIdentity,
  type Keyring,
  RECOVERY_SIGNER_ID,
  type RecoveryIdentity,
  type RecoveryPublicKeys,
  recoveryRecipient,
  type Sodium,
  wrapKeys,
} from "../crypto/index.js";
import { accepted, acceptedRecoveryWrap } from "./acceptance.js";
import { equalBytes, fromHex } from "./bytes.js";
import {
  buildRecoveryChanged,
  decodeRecoveryChanged,
  type LogEvent,
  RECOVERY_CHANGED,
  type RecoveryChangedData,
  type RecoveryKeysHex,
  recoveryChangeAuthorizationBody,
} from "./events.js";
import type { PreviousRecoveryKey, Registry } from "./registry.js";
import { verifyStatement } from "./statements.js";

export function recoveryKeysOf(hex: RecoveryKeysHex): RecoveryPublicKeys {
  return { boxPublicKey: fromHex(hex.box), signPublicKey: fromHex(hex.sign) };
}

export function sameRecoveryKeys(a: RecoveryPublicKeys, b: RecoveryPublicKeys): boolean {
  return equalBytes(a.boxPublicKey, b.boxPublicKey) && equalBytes(a.signPublicKey, b.signPublicKey);
}

/** The replaced recovery identity (the old words) authorized this change. */
export function authorizedByOldKeys(
  vaultId: string,
  eid: string,
  data: RecoveryChangedData,
): boolean {
  const { sig: _sig, ...unsigned } = data;
  return accepted(
    verifyStatement,
    "cashu/registry/v1",
    recoveryChangeAuthorizationBody(vaultId, eid, unsigned),
    fromHex(data.authorization),
    { kind: "recovery", signKeys: [recoveryKeysOf(data.from).signPublicKey] },
  );
}

/** The base wrap is signed by the new recovery identity and sealed for its box key. */
export function baseWrapValid(vaultId: string, data: RecoveryChangedData): boolean {
  const to = recoveryKeysOf(data.to);
  return acceptedRecoveryWrap(
    fromHex(data.baseWrap),
    vaultId,
    { deviceId: RECOVERY_SIGNER_ID, boxPublicKey: to.boxPublicKey },
    to.signPublicKey,
  );
}

/**
 * The event for a change to `next` (the owner typed the current words, `current`, and created new
 * words on this device). The caller writes it to its own stream; `VaultDevices.ingest` applies it
 * like anyone else's.
 */
export function buildRecoveryChange(
  sodium: Sodium,
  identity: DeviceIdentity,
  ring: Keyring,
  registry: Registry,
  current: RecoveryIdentity,
  next: RecoveryIdentity,
  eid: string,
  /** Other recovery-signed statements the changer accepted (the lease chain's recovery pins). */
  alsoRatify: readonly string[] = [],
): UnstampedEvent {
  if (!sameRecoveryKeys(current.publicKeys, ring.recovery)) {
    throw new RangeError("the current recovery words do not match the pinned recovery key");
  }
  if (!registry.isTrusted(identity.deviceId))
    throw new RangeError("only a trusted device changes the recovery key");
  const clone = ring.clone(sodium);
  try {
    clone.replaceRecoveryKey(next.publicKeys);
    const baseWrap = wrapKeys(sodium, clone, next, recoveryRecipient(clone));
    const certificates = [...registry.trusted.values()]
      .sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1))
      .map((d) =>
        certifyDevice(
          sodium,
          next,
          { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.boxPublicKey },
          ring.vaultId,
        ),
      );
    const ratified = [
      ...registry.events.filter((e) => e.data.signer === RECOVERY_SIGNER_ID).map((e) => e.eid),
      ...alsoRatify,
    ];
    return buildRecoveryChanged(identity, current, ring.vaultId, eid, {
      from: ring.recovery,
      to: next.publicKeys,
      baseWrap,
      certificates,
      ratified,
    });
  } finally {
    clone.wipe();
  }
}

export interface RecoveryHistory {
  /** Keys pinned before the current ones, oldest first, with what each change ratified. */
  readonly previous: readonly PreviousRecoveryKey[];
  /** Certificates by the recovery identities this device pinned since (bootstrap for the fold). */
  readonly certificates: readonly Uint8Array[];
}

/**
 * Rebuilds the pins that led to `current` from the change events in the log, walking back from the
 * current pin through changes whose base wrap the pinned key itself signed (only the holder of
 * those words could have made it). Used after a restart, when only the current pin is stored.
 */
export function recoveryHistory(
  vaultId: string,
  current: RecoveryPublicKeys,
  events: readonly LogEvent[],
): RecoveryHistory {
  const changes = events
    .filter((e) => e.type === RECOVERY_CHANGED && e.v === 1)
    .flatMap((e) => {
      const data = decodeRecoveryChanged(e.data);
      return data ? [{ event: e, data }] : [];
    })
    .sort((a, b) => (a.event.eid < b.event.eid ? -1 : a.event.eid > b.event.eid ? 1 : 0));
  const previous: PreviousRecoveryKey[] = [];
  const certificates: Uint8Array[] = [];
  const visited = new Set<string>();
  let key = current;
  for (;;) {
    const step = changes.find(
      (c) =>
        !visited.has(c.event.eid) &&
        sameRecoveryKeys(recoveryKeysOf(c.data.to), key) &&
        authorizedByOldKeys(vaultId, c.event.eid, c.data) &&
        baseWrapValid(vaultId, c.data),
    );
    if (!step) break;
    visited.add(step.event.eid);
    previous.unshift({
      keys: recoveryKeysOf(step.data.from),
      ratified: new Set(step.data.ratified),
    });
    certificates.push(...step.data.certificates.map(fromHex));
    key = recoveryKeysOf(step.data.from);
  }
  return { previous, certificates };
}
