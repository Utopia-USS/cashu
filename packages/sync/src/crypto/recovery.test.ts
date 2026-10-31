import { describe, expect, it } from "vitest";
import { CryptoError } from "./errors.js";
import { openFrame, sealFrame } from "./frame.js";
import { createKeyring, rotateKeyring } from "./keys.js";
import { createRecoveryKey, RECOVERY_WORDS, recoveryKeyPair } from "./recovery.js";
import { ctx, samplePlain, sodium } from "./testkit.js";
import { unwrapKeys, wrapKeys } from "./wrap.js";

function badMnemonic(phrase: string) {
  try {
    recoveryKeyPair(sodium, phrase);
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
    const { phrase, publicKey } = createRecoveryKey(sodium);
    expect(phrase.split(" ")).toHaveLength(RECOVERY_WORDS);
    expect(recoveryKeyPair(sodium, phrase).publicKey).toEqual(publicKey);
  });

  it("roundtrip: all devices lost, the words and the synced vault restore every generation", () => {
    const ring = createKeyring(sodium);
    const vaultId = ring.vaultId;
    const recovery = createRecoveryKey(sodium);
    const c = ctx(vaultId);
    const wraps = [wrapKeys(sodium, ring, recovery.publicKey)];
    const old = sealFrame(sodium, ring, samplePlain(), c);

    // A later rotation re-seals for the recovery public key; no device ever needs the words.
    const gen2 = rotateKeyring(sodium, ring);
    wraps.push(wrapKeys(sodium, ring, recovery.publicKey, [gen2.kid]));
    const recent = sealFrame(sodium, ring, samplePlain(), c);
    ring.wipe();

    const pair = recoveryKeyPair(sodium, recovery.phrase);
    const [first, ...rest] = wraps.map((w) => unwrapKeys(sodium, w, pair, vaultId));
    if (!first) throw new Error("no wraps");
    for (const r of rest) first.merge(r);
    expect(first.active.kid).toBe(gen2.kid);
    expect(openFrame(sodium, first, old, c)).toEqual(samplePlain());
    expect(openFrame(sodium, first, recent, c)).toEqual(samplePlain());
  });

  it("accepts case and whitespace variations of the same words", () => {
    const { phrase, publicKey } = createRecoveryKey(sodium);
    const messy = `  ${phrase.toUpperCase().split(" ").join("   \n")} `;
    expect(recoveryKeyPair(sodium, messy).publicKey).toEqual(publicKey);
  });

  it("rejects a wrong checksum, a wrong length and unknown words without echoing them", () => {
    const words = createRecoveryKey(sodium).phrase.split(" ");
    const swapped = [...words];
    // Replacing the last word almost always breaks the 8-bit checksum; pick one that does.
    for (const candidate of ["abandon", "ability", "able", "about"]) {
      swapped[23] = candidate;
      try {
        recoveryKeyPair(sodium, swapped.join(" "));
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
    const ring = createKeyring(sodium);
    const wrap = wrapKeys(sodium, ring, createRecoveryKey(sodium).publicKey);
    const other = recoveryKeyPair(sodium, createRecoveryKey(sodium).phrase);
    expect(() => unwrapKeys(sodium, wrap, other, ring.vaultId)).toThrowError(CryptoError);
  });
});
