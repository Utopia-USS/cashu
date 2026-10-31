import { describe, expect, it } from "vitest";
import { CryptoError } from "./errors.js";
import { openFrame, sealFrame } from "./frame.js";
import { createKeyring, rotateKeyring } from "./keys.js";
import { createRecoveryKey, RECOVERY_WORDS, recoveryIdentity } from "./recovery.js";
import { ctx, samplePlain, sodium } from "./testkit.js";
import { openPairingWrap, sealForPairing } from "./wrap.js";

function badMnemonic(phrase: string) {
  try {
    recoveryIdentity(sodium, phrase);
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError);
    expect((e as CryptoError).code).toBe("bad_mnemonic");
    // The message never echoes what the user typed.
    for (const word of phrase.split(/\s+/).filter(Boolean)) {
      expect((e as Error).message.split(/\W+/)).not.toContain(word);
    }
    return;
  }
  throw new Error("expected bad_mnemonic");
}

describe("recovery key", () => {
  it("is 24 words and reproduces the same public key", () => {
    const { phrase, publicKeys } = createRecoveryKey(sodium);
    expect(phrase.split(" ")).toHaveLength(RECOVERY_WORDS);
    expect(recoveryIdentity(sodium, phrase).publicKeys).toEqual(publicKeys);
  });

  it("roundtrip: all devices lost, the words and the synced vault restore every generation", () => {
    const recovery = createRecoveryKey(sodium);
    const ring = createKeyring(sodium, recovery.publicKeys);
    const vaultId = ring.vaultId;
    const c = ctx(vaultId);
    const wraps = [sealForPairing(sodium, ring, recovery.publicKeys.boxPublicKey)];
    const old = sealFrame(sodium, ring, samplePlain(), c);

    // A later rotation re-seals for the recovery public key; no device ever needs the words.
    const gen2 = rotateKeyring(sodium, ring);
    wraps.push(sealForPairing(sodium, ring, recovery.publicKeys.boxPublicKey));
    const recent = sealFrame(sodium, ring, samplePlain(), c);
    ring.wipe();

    const pair = recoveryIdentity(sodium, recovery.phrase);
    const [first, ...rest] = wraps.map((w) => openPairingWrap(sodium, w, pair, vaultId));
    if (!first) throw new Error("no wraps");
    for (const r of rest) first.merge(r);
    expect(first.active.kid).toBe(gen2.kid);
    expect(openFrame(sodium, first, old, c)).toEqual(samplePlain());
    expect(openFrame(sodium, first, recent, c)).toEqual(samplePlain());
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
    const wrap = sealForPairing(sodium, ring, recovery.publicKeys.boxPublicKey);
    const other = recoveryIdentity(sodium, createRecoveryKey(sodium).phrase);
    expect(() => openPairingWrap(sodium, wrap, other, ring.vaultId)).toThrowError(CryptoError);
  });
});
