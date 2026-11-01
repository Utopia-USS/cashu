// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 2.3, 8.2).
//
// A vault's keys on this device through the S27 `KeyStore`: the ring (data keys + gid salt) under
// `keyringName`, this device's identity under `deviceIdentityName`, and a pointer
// `cashu.vault.<vault>.device` naming the identity. The creator also keeps the vault's recovery
// material there (lab only, TRANSITIONAL(S44): the recovery words are shown by the pairing UI later).
import { crypto } from "@cashu/sync";
import type { VaultKeys } from "../vault.js";

const utf8 = new TextEncoder();
const text = new TextDecoder();
const deviceName = (vaultId: string) => `cashu.vault.${vaultId}.device`;

export async function loadVaultKeys(
  store: crypto.KeyStore,
  sodium: crypto.Sodium,
  vaultId: string,
): Promise<VaultKeys | undefined> {
  const ring = await crypto.loadKeyring(store, sodium, vaultId);
  const pointer = await store.get(deviceName(vaultId));
  if (ring === null || pointer === null) return undefined;
  const identity = await crypto.loadDeviceIdentity(store, text.decode(pointer));
  return identity === null ? undefined : { ring, identity };
}

/** A new vault created by this device (spec 8.2): ring, identity and recovery material stored. */
export async function createVault(
  store: crypto.KeyStore,
  sodium: crypto.Sodium,
): Promise<VaultKeys> {
  const identity = crypto.createDeviceIdentity(sodium);
  const recovery = crypto.createRecoveryKey(sodium);
  const recoveryId = crypto.recoveryIdentity(sodium, recovery.phrase);
  const created = crypto.createVaultWithRecovery(sodium, recoveryId, identity);
  recoveryId.wipe();
  const id = created.ring.vaultId;
  await crypto.saveKeyring(store, created.ring);
  await crypto.saveDeviceIdentity(store, identity);
  await store.set(deviceName(id), utf8.encode(identity.deviceId));
  await store.set(`cashu.vault.${id}.recovery`, utf8.encode(recovery.phrase.reveal()));
  await store.set(`cashu.vault.${id}.recoverywrap`, created.recoveryWrap);
  await store.set(`cashu.vault.${id}.creatorcert`, created.creatorCertificate);
  return { ring: created.ring, identity };
}
