import { inspect } from "node:util";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { describe, expect, it } from "vitest";
import { certifyDevice, verifyCertificates } from "./cert.js";
import { toHex } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { openFrame, sealFrame } from "./frame.js";
import { createDeviceIdentity, type DeviceIdentity, RECOVERY_SIGNER_ID } from "./identity.js";
import { createKeyring, createVaultId, rotateKeyring } from "./keys.js";
import { createRecoveryKey, RECOVERY_WORDS, recoveryIdentity } from "./recovery.js";
import type { Sodium } from "./sodium.js";
import { anyEpoch, backends, code, ctx, samplePlain } from "./testkit.js";
import { createVaultWithRecovery } from "./vault.js";
import { recoveryRecipient, type TrustedSigner, unwrapKeys, wrapKeys } from "./wrap.js";

describe.each(backends)("recovery key (%s)", (_name, sodium: Sodium) => {
  function badMnemonic(phrase: string) {
    try {
      recoveryIdentity(sodium, phrase);
    } catch (e) {
      expect(e).toBeInstanceOf(CryptoError);
      expect((e as CryptoError).code).toBe("bad_mnemonic");
      // The message is the fixed text, so it never echoes what the user typed.
      expect((e as Error).message).toBe(new CryptoError("bad_mnemonic").message);
      return;
    }
    throw new Error("expected bad_mnemonic");
  }

  it("is 24 words and reproduces the same public keys", () => {
    const { phrase, publicKeys } = createRecoveryKey(sodium);
    expect(phrase.reveal().split(" ")).toHaveLength(RECOVERY_WORDS);
    expect(recoveryIdentity(sodium, phrase).publicKeys).toEqual(publicKeys);
    expect(recoveryIdentity(sodium, phrase).deviceId).toBe(RECOVERY_SIGNER_ID);
  });

  /** The trustedSigner a recovering device builds: the recovery key plus certified devices only. */
  function trustFromCertificates(
    vaultId: string,
    recoverySignPublicKey: Uint8Array,
    certs: Uint8Array[],
  ): TrustedSigner {
    const { devices } = verifyCertificates(
      sodium,
      vaultId,
      recoverySignPublicKey,
      certs,
      new Set(),
    );
    return (id) =>
      id === RECOVERY_SIGNER_ID ? recoverySignPublicKey : devices.get(id)?.signPublicKey;
  }

  it("roundtrip: all devices lost, the words and the synced vault restore every generation", () => {
    const recovery = createRecoveryKey(sodium);
    const desktop = createDeviceIdentity(sodium);
    const phone = createDeviceIdentity(sodium);
    const ring = createKeyring(sodium, recovery.publicKeys);
    const vaultId = ring.vaultId;
    const c = ctx(vaultId, { deviceId: desktop.deviceId });
    // At vault creation the words are on screen: the recovery identity certifies the desktop and
    // signs the first recovery wrap. Storage keeps certificates next to the wraps.
    const creator = recoveryIdentity(sodium, recovery.phrase);
    const certs = [certifyDevice(sodium, creator, subjectOf(desktop), vaultId)];
    const wraps = [wrapKeys(sodium, ring, creator, recoveryRecipient(ring))];
    creator.wipe();
    // Later the desktop pairs the phone and certifies it (a chain).
    certs.push(certifyDevice(sodium, desktop, subjectOf(phone), vaultId));
    const old = sealFrame(sodium, ring, samplePlain(), c);

    // Later rotations are wrapped for the recovery key by devices; no device needs the words.
    const gen2 = rotateKeyring(sodium, ring);
    wraps.push(wrapKeys(sodium, ring, desktop, recoveryRecipient(ring), [gen2.kid]));
    const gen3 = rotateKeyring(sodium, ring);
    wraps.push(wrapKeys(sodium, ring, phone, recoveryRecipient(ring), [gen3.kid]));
    const recent = sealFrame(sodium, ring, samplePlain(), c);
    ring.wipe();

    const identity = recoveryIdentity(sodium, recovery.phrase);
    // Trust comes ONLY from the certificate chain rooted at the recovery signing key.
    const trust = trustFromCertificates(vaultId, identity.signPublicKey, [...certs].reverse());
    const [first, ...rest] = wraps;
    if (!first) throw new Error("no wraps");
    const { ring: restored } = unwrapKeys(
      sodium,
      first,
      identity,
      { vaultId, recoveryPublicKey: recovery.publicKeys },
      trust,
      anyEpoch,
    );
    for (const w of rest) unwrapKeys(sodium, w, identity, restored, trust, anyEpoch);
    expect(restored.active.kid).toBe(gen3.kid);
    expect(openFrame(sodium, restored, old, c)).toEqual(samplePlain());
    expect(openFrame(sodium, restored, recent, c)).toEqual(samplePlain());
  });

  it("storage cannot add a device: self-signed or uncertified-signer certificates are not trusted", () => {
    const recovery = createRecoveryKey(sodium);
    const ring = createKeyring(sodium, recovery.publicKeys);
    const vaultId = ring.vaultId;
    const identity = recoveryIdentity(sodium, recovery.phrase);
    const desktop = createDeviceIdentity(sodium);
    const attacker = createDeviceIdentity(sodium);
    const accomplice = createDeviceIdentity(sodium);
    const certs = [
      certifyDevice(sodium, identity, subjectOf(desktop), vaultId),
      certifyDevice(sodium, attacker, subjectOf(attacker), vaultId), // self-signed
      certifyDevice(sodium, accomplice, subjectOf(attacker), vaultId), // uncertified signer
      certifyDevice(sodium, attacker, subjectOf(accomplice), vaultId), // cycle
      certifyDevice(sodium, identity, subjectOf(attacker), createVaultId(sodium)), // another vault
    ];
    const tampered = certifyDevice(sodium, desktop, subjectOf(attacker), vaultId);
    tampered[20] = (tampered[20] ?? 0) ^ 1; // breaks the signature (and the subject id)
    certs.push(tampered);
    const { devices, conflicts } = verifyCertificates(
      sodium,
      vaultId,
      identity.signPublicKey,
      certs,
      new Set(),
    );
    expect([...devices.keys()]).toEqual([desktop.deviceId]);
    expect(conflicts).toEqual([]);
    // Order does not matter.
    expect([
      ...verifyCertificates(
        sodium,
        vaultId,
        identity.signPublicKey,
        [...certs].reverse(),
        new Set(),
      ).devices.keys(),
    ]).toEqual([desktop.deviceId]);

    const trust = trustFromCertificates(vaultId, identity.signPublicKey, certs);
    const target = { vaultId, recoveryPublicKey: recovery.publicKeys };
    // The attacker knows the recovery public keys (every device does) and signs its own wrap.
    const planted = wrapKeys(sodium, ring, attacker, recoveryRecipient(ring));
    expect(code(() => unwrapKeys(sodium, planted, identity, target, trust, anyEpoch))).toBe(
      "untrusted_sender",
    );
    // A certified desktop still cannot seed the base: only the words' own wrap can (D18).
    const byDesktop = wrapKeys(sodium, ring, desktop, recoveryRecipient(ring));
    expect(code(() => unwrapKeys(sodium, byDesktop, identity, target, trust, anyEpoch))).toBe(
      "untrusted_sender",
    );
    // Seeded from the recovery-signed wrap, the certified desktop's wrap extends the base.
    const base = wrapKeys(sodium, ring, identity, recoveryRecipient(ring));
    const { ring: restored } = unwrapKeys(sodium, base, identity, target, trust, anyEpoch);
    rotateKeyring(sodium, ring);
    const next = wrapKeys(sodium, ring, desktop, recoveryRecipient(ring), [ring.active.kid]);
    expect(unwrapKeys(sodium, next, identity, restored, trust, anyEpoch).senderDeviceId).toBe(
      desktop.deviceId,
    );
  });

  it("F8: logging or serializing a new recovery key shows no words", () => {
    const created = createRecoveryKey(sodium);
    const words = created.phrase.reveal().split(" ");
    const shown = [
      JSON.stringify(created),
      String(created.phrase),
      `${created.phrase}`,
      inspect(created, { depth: 5, showHidden: true }),
    ].join("\n");
    for (let i = 1; i < words.length; i++) {
      expect(shown).not.toContain(`${words[i - 1]} ${words[i]}`);
    }
    expect(recoveryIdentity(sodium, created.phrase).publicKeys).toEqual(created.publicKeys);
  });

  it("accepts case and whitespace variations of the same words", () => {
    const { phrase, publicKeys } = createRecoveryKey(sodium);
    const messy = `  ${phrase.reveal().toUpperCase().split(" ").join("   \n")} `;
    expect(recoveryIdentity(sodium, messy).publicKeys).toEqual(publicKeys);
  });

  it("rejects a wrong checksum, a wrong length and unknown words without echoing them", () => {
    const words = createRecoveryKey(sodium).phrase.reveal().split(" ");
    // Only 8 of the 2048 last words complete a valid checksum: take the first that does not.
    const first23 = words.slice(0, 23);
    const wrong = wordlist.find(
      (w) => code(() => recoveryIdentity(sodium, [...first23, w].join(" "))) === "bad_mnemonic",
    );
    if (wrong === undefined) throw new Error("every last word passed the checksum");
    badMnemonic([...first23, wrong].join(" "));
    badMnemonic(words.slice(0, 12).join(" "));
    badMnemonic([...words.slice(0, 23), "notaword"].join(" "));
    badMnemonic("");
  });

  it("D18: a certified device's whole-ring wrap cannot seed a recovering device (salt and base come from the words)", () => {
    const recovery = createRecoveryKey(sodium);
    const words = recoveryIdentity(sodium, recovery.phrase);
    const creator = createDeviceIdentity(sodium);
    const thief = createDeviceIdentity(sodium);
    const vault = createVaultWithRecovery(sodium, words, creator);
    const vaultId = vault.ring.vaultId;
    const certs = [
      vault.creatorCertificate,
      certifyDevice(sodium, creator, subjectOf(thief), vaultId),
    ];
    const trust = trustFromCertificates(vaultId, words.signPublicKey, certs);
    // The thief (certified, its revocation withheld by storage) offers its own vault-shaped ring.
    const evil = createKeyring(sodium, recovery.publicKeys, vaultId);
    const poisoned = wrapKeys(sodium, evil, thief, recoveryRecipient(evil));
    const restoring = recoveryIdentity(sodium, recovery.phrase);
    const target = { vaultId, recoveryPublicKey: recovery.publicKeys };
    expect(code(() => unwrapKeys(sodium, poisoned, restoring, target, trust, anyEpoch))).toBe(
      "untrusted_sender",
    );
    const { ring } = unwrapKeys(sodium, vault.recoveryWrap, restoring, target, trust, anyEpoch);
    expect(toHex(ring.gidSalt().expose())).toBe(toHex(vault.ring.gidSalt().expose()));
    expect(ring.active.kid).toBe(vault.ring.active.kid);
    // Extending from the thief is still refused: its salt differs from the pinned one.
    rotateKeyring(sodium, evil);
    const extend = wrapKeys(sodium, evil, thief, recoveryRecipient(evil), [evil.active.kid]);
    expect(code(() => unwrapKeys(sodium, extend, restoring, ring, trust, anyEpoch))).toBe(
      "gid_salt_mismatch",
    );
  });

  it("a different phrase cannot open the recovery wrap", () => {
    const recovery = createRecoveryKey(sodium);
    const ring = createKeyring(sodium, recovery.publicKeys);
    const words = recoveryIdentity(sodium, recovery.phrase);
    const wrap = wrapKeys(sodium, ring, words, recoveryRecipient(ring));
    const other = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const target = { vaultId: ring.vaultId, recoveryPublicKey: recovery.publicKeys };
    expect(
      code(() => unwrapKeys(sodium, wrap, other, target, () => words.signPublicKey, anyEpoch)),
    ).toBe("auth_failed");
  });
});

function subjectOf(d: DeviceIdentity) {
  return { deviceId: d.deviceId, signPublicKey: d.signPublicKey, boxPublicKey: d.box.publicKey };
}
