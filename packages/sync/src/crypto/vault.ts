// Vault creation with its recovery trust root, the documented sequence in one call: while the 24
// words are on screen, the recovery identity certifies the creating device and seals the whole
// generation-1 ring (with the gid salt) for the recovery recipient. A device recovering later seeds
// its ring only from that wrap and trusts devices only through certificates rooted at the words.

import { certifyDevice } from "./cert.js";
import type { DeviceIdentity, RecoveryIdentity } from "./identity.js";
import { createKeyring, type Keyring } from "./keyring.js";
import type { Sodium } from "./sodium.js";
import { recoveryRecipient, wrapKeys } from "./wrap.js";

export interface NewVault {
  ring: Keyring;
  /** The base wrap for recovery, signed by the recovery identity; store it with the vault. */
  recoveryWrap: Uint8Array;
  /** The creating device certified by the recovery identity; store it with the vault. */
  creatorCertificate: Uint8Array;
}

export function createVaultWithRecovery(
  sodium: Sodium,
  recovery: RecoveryIdentity,
  creator: DeviceIdentity,
  vaultId?: string,
): NewVault {
  const ring = createKeyring(sodium, recovery.publicKeys, vaultId);
  const creatorCertificate = certifyDevice(
    sodium,
    recovery,
    {
      deviceId: creator.deviceId,
      signPublicKey: creator.signPublicKey,
      boxPublicKey: creator.box.publicKey,
    },
    ring.vaultId,
  );
  const recoveryWrap = wrapKeys(sodium, ring, recovery, recoveryRecipient(ring));
  return { ring, recoveryWrap, creatorCertificate };
}
