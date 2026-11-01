// TRANSITIONAL(S49): the lab / dev host's frame gate (S29c phase B2).
//
// The lab host runs without the device registry (no pairing, S31a deviation: rings come from the lab
// key store), so it cannot use `DeviceFrameGate`. Every device of a lab vault is instead certified by
// the vault's recovery identity when it is created (the creator, the genesis device, each harness
// device), and the certificates are kept in the lab key store (`labCertificates`). This gate accepts
// a frame only when its head verifies under the key such a certificate gives its writer; any other
// writer waits. It decides nothing about data (no revocations exist in the lab).
import { crypto, type FrameGate } from "@cashu/sync";
import { labCertificates } from "./vaultKeys.js";

/** The gate of one lab vault: the certificates the key store holds when the vault is opened. */
export async function labGate(
  store: crypto.KeyStore,
  sodium: crypto.Sodium,
  ring: crypto.Keyring,
): Promise<FrameGate> {
  const check = crypto.verifyCertificates(
    sodium,
    ring.vaultId,
    ring.recovery.signPublicKey,
    await labCertificates(store, ring.vaultId),
    new Set(),
  );
  const keys = new Map([...check.devices].map(([id, d]) => [id, d.signPublicKey.slice()]));
  return {
    authenticate(head) {
      const key = keys.get(head.device);
      if (!key) return { ok: false, wait: true, code: "writer-unknown" };
      return crypto.verifyHeadSignature(ring.vaultId, head, key)
        ? { ok: true }
        : { ok: false, wait: false, code: "bad_head_signature" };
    },
    accept: () => ({ verdict: { ok: true }, changed: false }),
    observe() {},
    needsReplay: () => false,
    takeRebuild: () => false,
    reset() {},
  };
}
