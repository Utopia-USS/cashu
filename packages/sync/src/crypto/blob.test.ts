import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { blobSize, openBlob, sealBlob, sealBlobWithNonce } from "./blob.js";
import { toHex, utf8 } from "./encoding.js";
import { createDeviceIdentity, RECOVERY_SIGNER_ID } from "./identity.js";
import { createKeyring, rotateKeyring } from "./keys.js";
import { recoveryIdentity } from "./recovery.js";
import { keyringFromKeys } from "./testing.js";
import { anyEpoch, backends, code, GID_SALT, pairWith, range, sodium } from "./testkit.js";
import { createVaultWithRecovery } from "./vault.js";
import { unwrapKeys } from "./wrap.js";

const vaultId = "00112233445566778899aabbccddeeff";
const sample = utf8("synthetic staged statement bytes");
const ref = { sha256: toHex(sha256(sample)), ext: "csv" };

describe("vault-key blob format", () => {
  it("has a frozen portable v1 vector", () => {
    const recovery = recoveryIdentity(sodium, `${"abandon ".repeat(23)}art`);
    const ring = keyringFromKeys(
      sodium,
      {
        vaultId,
        recovery: recovery.publicKeys,
        gidSalt: GID_SALT,
      },
      [{ generation: 1, epoch: 0, key: range(0x00, 0x1f) }],
    );
    try {
      const sealed = sealBlobWithNonce(sodium, ring, vaultId, ref, sample, range(0xa0, 0xb7));
      expect(toHex(sealed)).toBe(
        "017bd6215fabb945b83e9fe5c54e25bd1da0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b74a89e0ba3dafb556eb592b20c9e1ff72725c4f7fde22054f85e15964d797a0237b0c6d050b05f42dbca1a6569fd0bf09177571a8",
      );
      expect(sealed.length).toBe(blobSize(sample.length));
      expect(openBlob(sodium, ring, vaultId, ref, sealed)).toEqual(sample);
    } finally {
      ring.wipe();
      recovery.wipe();
    }
  });

  it.each(backends)("%s binds vault, hash, extension, ciphertext and keeps old epochs", (_, s) => {
    const recovery = recoveryIdentity(s, `${"abandon ".repeat(23)}art`);
    const creator = createDeviceIdentity(s);
    const { ring, recoveryWrap } = createVaultWithRecovery(s, recovery, creator);
    const second = createDeviceIdentity(s);
    const paired = pairWith(s, ring, second);
    const recovered = unwrapKeys(
      s,
      recoveryWrap,
      recovery,
      { vaultId: ring.vaultId, recoveryPublicKey: recovery.publicKeys },
      (sender) => (sender === RECOVERY_SIGNER_ID ? recovery.signPublicKey : undefined),
      anyEpoch,
    ).ring;
    try {
      const sealed = sealBlob(s, ring, ring.vaultId, ref, sample);
      expect(openBlob(s, paired, ring.vaultId, ref, sealed)).toEqual(sample);
      expect(openBlob(s, recovered, ring.vaultId, ref, sealed)).toEqual(sample);
      const tampered = sealed.slice();
      tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
      expect(code(() => openBlob(s, ring, ring.vaultId, ref, tampered))).toBe("auth_failed");
      expect(code(() => openBlob(s, ring, ring.vaultId, { ...ref, ext: "txt" }, sealed))).toBe(
        "auth_failed",
      );
      expect(
        code(() => openBlob(s, ring, ring.vaultId, { ...ref, sha256: "00".repeat(32) }, sealed)),
      ).toBe("auth_failed");
      const foreign = createKeyring(s, recovery.publicKeys);
      try {
        expect(code(() => openBlob(s, foreign, foreign.vaultId, ref, sealed))).toBe("unknown_key");
      } finally {
        foreign.wipe();
      }
      rotateKeyring(s, ring);
      expect(openBlob(s, ring, ring.vaultId, ref, sealed)).toEqual(sample);
      const newer = sealBlob(s, ring, ring.vaultId, ref, sample);
      expect(code(() => openBlob(s, paired, ring.vaultId, ref, newer))).toBe("unknown_key");
      expect(openBlob(s, ring, ring.vaultId, ref, newer)).toEqual(sample);
      expect(
        code(() => sealBlob(s, ring, ring.vaultId, { ...ref, sha256: "00".repeat(32) }, sample)),
      ).toBe("bad_payload");
    } finally {
      recovered.wipe();
      paired.wipe();
      ring.wipe();
      creator.wipe();
      second.wipe();
      recovery.wipe();
    }
  });
});
