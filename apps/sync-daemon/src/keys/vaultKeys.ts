// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 2.3, 8.2).
//
// A vault's keys on this device through the S27 `KeyStore`: the ring (data keys + gid salt) under
// `keyringName`, this device's identity under `deviceIdentityName`, and a pointer
// `cashu.vault.<vault>.device` naming the identity. The creator also keeps the vault's recovery
// material there (lab only, TRANSITIONAL(S44): the recovery words are shown by the pairing UI later).
import { vaultSalt } from "@cashu/store";
import * as genesis from "@cashu/store/genesis";
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

const certsName = (vaultId: string) => `cashu.vault.${vaultId}.labcerts`;

/** Recovery-issued certificates of the lab vault's devices (labGate.ts): concatenated, fixed size. */
export async function labCertificates(
  store: crypto.KeyStore,
  vaultId: string,
): Promise<Uint8Array[]> {
  const all = await store.get(certsName(vaultId));
  const out: Uint8Array[] = [];
  for (let i = 0; all !== null && i + crypto.CERT_BYTES <= all.length; i += crypto.CERT_BYTES) {
    out.push(all.slice(i, i + crypto.CERT_BYTES));
  }
  return out;
}

async function addLabCertificate(
  store: crypto.KeyStore,
  vaultId: string,
  cert: Uint8Array,
): Promise<void> {
  const known = (await store.get(certsName(vaultId))) ?? new Uint8Array(0);
  const next = new Uint8Array(known.length + cert.length);
  next.set(known);
  next.set(cert, known.length);
  await store.set(certsName(vaultId), next);
}

function subjectOf(identity: crypto.DeviceIdentity) {
  return {
    deviceId: identity.deviceId,
    signPublicKey: identity.signPublicKey,
    boxPublicKey: identity.box.publicKey,
  };
}

/**
 * Certifies a lab device of `vaultId` with the recovery identity the lab key store keeps for it, so
 * every lab gate verifies its frames (S31a deviation: no pairing in the lab).
 */
export async function certifyLabDevice(
  store: crypto.KeyStore,
  sodium: crypto.Sodium,
  vaultId: string,
  identity: crypto.DeviceIdentity,
): Promise<void> {
  const phrase = await store.get(`cashu.vault.${vaultId}.recovery`);
  if (phrase === null) throw new Error("the lab key store holds no recovery words for this vault");
  const recovery = crypto.recoveryIdentity(sodium, text.decode(phrase));
  try {
    const cert = crypto.certifyDevice(sodium, recovery, subjectOf(identity), vaultId);
    await addLabCertificate(store, vaultId, cert);
  } finally {
    recovery.wipe();
  }
}

/** A new vault created by this device (spec 8.2): ring, identity and recovery material stored. */
export async function createVault(
  store: crypto.KeyStore,
  sodium: crypto.Sodium,
): Promise<VaultKeys & { readonly genesis: crypto.DeviceIdentity }> {
  const identity = crypto.createDeviceIdentity(sodium);
  const recovery = crypto.createRecoveryKey(sodium);
  const recoveryId = crypto.recoveryIdentity(sodium, recovery.phrase);
  const created = crypto.createVaultWithRecovery(sodium, recoveryId, identity);
  // The genesis device (lead decision B2): its own identity, under the genesis device id of the
  // vault (store genesis derives it from the salt), certified by the recovery key now; it writes the
  // genesis stream during `init` and is retired after it (the key lives only in memory).
  const secret = created.ring.gidSalt();
  const genesisId = genesis.genesisDevice(vaultSalt(secret.expose().slice()));
  secret.wipe();
  const genesisIdentity = crypto.createDeviceIdentity(sodium, genesisId);
  const genesisCert = crypto.certifyDevice(
    sodium,
    recoveryId,
    subjectOf(genesisIdentity),
    created.ring.vaultId,
  );
  recoveryId.wipe();
  const id = created.ring.vaultId;
  await addLabCertificate(store, id, created.creatorCertificate);
  await addLabCertificate(store, id, genesisCert);
  await crypto.saveKeyring(store, created.ring);
  await crypto.saveDeviceIdentity(store, identity);
  await store.set(deviceName(id), utf8.encode(identity.deviceId));
  await store.set(`cashu.vault.${id}.recovery`, utf8.encode(recovery.phrase.reveal()));
  await store.set(`cashu.vault.${id}.recoverywrap`, created.recoveryWrap);
  await store.set(`cashu.vault.${id}.creatorcert`, created.creatorCertificate);
  return { ring: created.ring, identity, genesis: genesisIdentity };
}
