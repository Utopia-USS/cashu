import { describe, expect, it } from "vitest";
import { CryptoError } from "./errors.js";
import { openFrame, sealFrame } from "./frame.js";
import { createDeviceIdentity, RECOVERY_SIGNER_ID } from "./identity.js";
import { createKeyring, rotateKeyring } from "./keys.js";
import { createRecoveryKey, RECOVERY_WORDS, recoveryIdentity } from "./recovery.js";
import type { Sodium } from "./sodium.js";
import { backends, code, ctx, samplePlain } from "./testkit.js";
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
    expect(phrase.split(" ")).toHaveLength(RECOVERY_WORDS);
    expect(recoveryIdentity(sodium, phrase).publicKeys).toEqual(publicKeys);
    expect(recoveryIdentity(sodium, phrase).deviceId).toBe(RECOVERY_SIGNER_ID);
  });

  it("roundtrip: all devices lost, the words and the synced vault restore every generation", () => {
    const recovery = createRecoveryKey(sodium);
    const desktop = createDeviceIdentity(sodium);
    const ring = createKeyring(sodium, recovery.publicKeys);
    const vaultId = ring.vaultId;
    const c = ctx(vaultId, { deviceId: desktop.deviceId });
    // At vault creation the words are on screen: the recovery identity signs the first wrap.
    const creator = recoveryIdentity(sodium, recovery.phrase);
    const wraps = [wrapKeys(sodium, ring, creator, recoveryRecipient(ring))];
    creator.wipe();
    const old = sealFrame(sodium, ring, samplePlain(), c);

    // A later rotation is wrapped for the recovery key by a device; no device needs the words.
    const gen2 = rotateKeyring(sodium, ring);
    wraps.push(wrapKeys(sodium, ring, desktop, recoveryRecipient(ring), [gen2.kid]));
    const recent = sealFrame(sodium, ring, samplePlain(), c);
    ring.wipe();

    const identity = recoveryIdentity(sodium, recovery.phrase);
    // Trust root: the recovery signing key; the desktop's key would come from the registry it signs (S29).
    const trust: TrustedSigner = (id) =>
      id === RECOVERY_SIGNER_ID
        ? identity.signPublicKey
        : id === desktop.deviceId
          ? desktop.signPublicKey
          : undefined;
    const [first, ...rest] = wraps;
    if (!first) throw new Error("no wraps");
    const { ring: restored } = unwrapKeys(
      sodium,
      first,
      identity,
      { vaultId, recoveryPublicKey: recovery.publicKeys },
      trust,
    );
    for (const w of rest) unwrapKeys(sodium, w, identity, restored, trust);
    expect(restored.active.kid).toBe(gen2.kid);
    expect(openFrame(sodium, restored, old, c)).toEqual(samplePlain());
    expect(openFrame(sodium, restored, recent, c)).toEqual(samplePlain());
  });

  it("a recovering device accepts only wraps signed by the recovery identity or a device it trusts", () => {
    const recovery = createRecoveryKey(sodium);
    const ring = createKeyring(sodium, recovery.publicKeys);
    const target = { vaultId: ring.vaultId, recoveryPublicKey: recovery.publicKeys };
    const identity = recoveryIdentity(sodium, recovery.phrase);
    const trusted = createDeviceIdentity(sodium);
    const stranger = createDeviceIdentity(sodium);
    const trust: TrustedSigner = (id) =>
      id === RECOVERY_SIGNER_ID
        ? identity.signPublicKey
        : id === trusted.deviceId
          ? trusted.signPublicKey
          : undefined;

    const bySelf = wrapKeys(sodium, ring, identity, recoveryRecipient(ring));
    const byTrusted = wrapKeys(sodium, ring, trusted, recoveryRecipient(ring));
    const byStranger = wrapKeys(sodium, ring, stranger, recoveryRecipient(ring));
    expect(unwrapKeys(sodium, bySelf, identity, target, trust).senderDeviceId).toBe(
      RECOVERY_SIGNER_ID,
    );
    expect(unwrapKeys(sodium, byTrusted, identity, target, trust).senderDeviceId).toBe(
      trusted.deviceId,
    );
    expect(code(() => unwrapKeys(sodium, byStranger, identity, target, trust))).toBe(
      "untrusted_sender",
    );

    // A stranger claiming the recovery signer id fails the signature check.
    const forged = byStranger.slice();
    forged.fill(0, 1, 17);
    expect(code(() => unwrapKeys(sodium, forged, identity, target, trust))).toBe("auth_failed");
  });

  it("accepts case and whitespace variations of the same words", () => {
    const { phrase, publicKeys } = createRecoveryKey(sodium);
    const messy = `  ${phrase.toUpperCase().split(" ").join("   \n")} `;
    expect(recoveryIdentity(sodium, messy).publicKeys).toEqual(publicKeys);
  });

  it("rejects a wrong checksum, a wrong length and unknown words without echoing them", () => {
    const words = createRecoveryKey(sodium).phrase.split(" ");
    const swapped = [...words];
    // Replacing the last word almost always breaks the 8-bit checksum; pick one that does.
    for (const candidate of ["abandon", "ability", "able", "about"]) {
      swapped[23] = candidate;
      try {
        recoveryIdentity(sodium, swapped.join(" "));
      } catch {
        break;
      }
    }
    badMnemonic(swapped.join(" "));
    badMnemonic(words.slice(0, 12).join(" "));
    badMnemonic([...words.slice(0, 23), "notaword"].join(" "));
    badMnemonic("");
  });

  it("a different phrase cannot open the recovery wrap", () => {
    const recovery = createRecoveryKey(sodium);
    const ring = createKeyring(sodium, recovery.publicKeys);
    const desktop = createDeviceIdentity(sodium);
    const wrap = wrapKeys(sodium, ring, desktop, recoveryRecipient(ring));
    const other = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    const target = { vaultId: ring.vaultId, recoveryPublicKey: recovery.publicKeys };
    expect(code(() => unwrapKeys(sodium, wrap, other, target, () => desktop.signPublicKey))).toBe(
      "auth_failed",
    );
  });
});
