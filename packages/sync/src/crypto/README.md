# packages/sync/src/crypto (S27)

Encryption and keys for the sync log. Everything goes through one `Sodium` interface, which runs a
known-answer self-test when it is built (`unsupported_runtime` on any failure):

- Node / Electron: `loadNodeSodium()` (`libsodium-wrappers`, standard build).
- Mobile: `fromLibsodium(sodium, { aead: "noble" })` with `import * as sodium from "react-native-libsodium"`
  (the namespace, not the default export: the default object lacks `crypto_box_seal`). The AEAD then
  runs on `@noble/ciphers`, because react-native-libsodium 1.7 throws "input type not yet implemented"
  for binary additional data. Ed25519 and X25519 public-from-secret run on `@noble/curves` everywhere.

Test helpers that must never reach the app (`InMemoryKeyStore`) live on the `@cashu/sync/testing` subpath.

## Formats (frozen by golden vectors in `vectors.test.ts`; a change needs a new version byte or tag)

`lp(x)` = u32 big-endian length + bytes. All integers big-endian.

| What        | Bytes                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subkeys     | `frameKey = BLAKE2b-256(key = data key, "cashu/subkey/frame/v2")`, `kidKey = BLAKE2b-256(key = data key, "cashu/subkey/kid/v2")`; the raw data key is used for nothing else |
| Key id      | `hex(BLAKE2b-128(key = kidKey, "cashu/kid/v2" \| lp(vault id) \| u32 generation \| u32 epoch))`; always computed, never accepted                                            |
| Frame       | `0x02` \| key id (16) \| nonce (24) \| XChaCha20-Poly1305(frameKey) ciphertext + tag (16)                                                                                   |
| Frame AAD   | `"cashu/frame/v2"` \| `0x02` \| key id \| lp(vault id) \| lp(device id) \| u32 segment \| u64 offset                                                                        |
| Frame plain | u32 length \| data \| zero padding to Padme(length + 4); max 64 MiB of data                                                                                                 |
| Key payload | `"cashu/keys/v2"` \| lp(vault id) \| recovery box pk (32) \| recovery sign pk (32) \| gid salt (32) \| u16 count \| (u32 generation \| u32 epoch \| key 32)*                |
| Signed wrap | `0x02` \| sender device id (16) \| Ed25519 signature (64) \| `crypto_box_seal(payload, recipient box pk)`                                                                   |
| Wrap signed | `"cashu/wrap/v2"` \| lp(vault id) \| sender id \| recipient id \| recipient box pk \| sealed                                                                                |
| Pairing box | `crypto_box_seal(payload, new device box pk)` (first hop only, see below)                                                                                                   |
| Device blob | `"cashu/device/v2"` \| device id (16) \| box secret key (32) \| Ed25519 seed (32); public keys recomputed on load                                                           |
| Mobile blob | `0x01` \| nonce (24) \| XChaCha20-Poly1305(Keychain KEK, AAD = item name)                                                                                                   |
| Recovery    | 24 BIP39 words = 256-bit entropy -> HKDF-SHA256(salt `"cashu/recovery/v2"`): info `"x25519-seed"` -> `crypto_box_seed_keypair`, info `"ed25519-seed"` -> Ed25519 seed       |

Ids: vault id and device id are 16 random bytes as 32 lowercase hex characters (`createVaultId`,
`createDeviceId`), validated everywhere. The all-zero id is `RECOVERY_SIGNER_ID`, never a device.
Generations and epochs are bounded to 1..2^20 and 0..2^20.

## What consumers rely on

### S28b (carrier)

- `sealFrame` / `openFrame(sodium, ring, frame, {vaultId, deviceId, segment, offset}, policy?)` per frame;
  the carrier adds the u32 length prefix of each frame in a segment file. `frameKeyId` tells which
  key a frame needs before trying it. Errors are `CryptoError` with a `code`; a frame that fails is
  rejected, never partly applied.
- **Revocation stops a revoked device from READING new data only.** It still holds old keys, and old
  keys stay in every ring to read history, so without more it can keep WRITING frames that open. Until
  per-device frame signatures land (S28d), the carrier must enforce a per-device generation floor
  through the policy hook: `openFrame(..., { minGeneration })` or `{ acceptKid: (entry) => ... }`, both
  checked before decrypting (`key_not_allowed`). Frames of a revoked device after its revocation point
  are rejected outright.
- Frame version 2 means "Padme v1 padding, no codec". Compression stays the carrier's, but the codec
  must then be recorded in the version byte / AAD and the decompressed size capped (a key holder, e.g.
  a revoked device, could otherwise ship a zip bomb). `frameSize(n)` gives the ciphertext size.
- Gids: `ring.gidSalt()` is the HMAC-SHA256 key for deterministic gids (event spec v1.1). It is
  generated with the vault, travels only inside the authenticated key payload, is never rotated and is
  never derived from a data key; a payload with another salt is refused (`gid_salt_mismatch`).
- Not covered by frame-level AEAD (m10, tracked for S28b / S28d): truncation, rollback or withholding
  of whole frames or segments by storage, and forks if a reinstalled device reuses its device id and
  rewrites offsets. These need signed per-device heads (segment, offset, hash chain) and a fresh
  device id per install (never restore a device identity onto another install).

### S29 (pairing, registry, rotation, revocation)

- Each device has a `DeviceIdentity` (`createDeviceIdentity`): an X25519 box key and an Ed25519 signing
  key, stored with `saveDeviceIdentity` / `loadDeviceIdentity`. The registry publishes
  `{deviceId, boxPublicKey, signPublicKey}`.
- **Pairing, first hop only**: `sealForPairing(ring, newDeviceBoxPk)` / `openPairingWrap`. A sealed box
  authenticates nothing about its sender, so S29 must guarantee: the desktop seals only for a public key
  it authenticated (QR scanned in person, or a short authentication string); the SAS covers both
  devices' public keys, the vault id, the recovery public keys and the hash of the wrap, with
  commit-then-reveal so a man in the middle cannot grind a 6-digit (20-bit) SAS; the new device learns
  the registry root (owner device signing keys) from that same authenticated exchange. The payload
  carries the recovery public keys and the gid salt, which is how they get pinned on the new device.
- **Every later wrap is signed**: `wrapKeys(ring, sender, recipient, kids?)` and
  `unwrapKeys(wire, recipient, ring | {vaultId, recoveryPublicKey}, trustedSigner)`. `trustedSigner(id)`
  returns the signing key of a device that is registered and NOT revoked (S29's registry), else
  undefined (`untrusted_sender`). The signature is checked before opening (`auth_failed`).
  `unwrapKeys` returns `{ ring, senderDeviceId }`.
- **Acceptance policy** (`Keyring.merge`, used by every path that adds keys): same vault id
  (`vault_mismatch`), same pinned recovery keys (`recovery_key_mismatch`), same gid salt
  (`gid_salt_mismatch`), and new keys taken in ascending (generation, epoch, kid) with each generation
  at most one above the highest held (`generation_gap`). Any violation rejects the whole merge. A device
  that missed a rotation applies wraps in generation order. "Merging rings is a union" is NOT the rule.
- **Rotation / revocation**: `rotateKeyring(ring, { epoch })`, where epoch = the number of device
  revocations the rotator has applied (never lower than the active key's). `active` is the highest
  (generation, epoch, kid). Revoking = rotate with the incremented epoch and wrap the new kid for every
  remaining device and for `recoveryRecipient(ring)`. A concurrent plain rotation at the same generation
  has the lower epoch and loses. **Remaining race, S29 rule**: after merging, if the active key was
  wrapped for any device revoked in the merged registry, rotate again (S27 cannot see the registry).
- **Recovery**: `createRecoveryKey` -> `{ phrase, publicKeys }`; `createKeyring(sodium, publicKeys)` pins
  them. `recoveryIdentity(phrase)` signs as `RECOVERY_SIGNER_ID`, so a recovering device has a trust root:
  its `trustedSigner` returns the recovery signing key for that id, and accepts device signers only as
  it learns them from material the recovery identity (or a trusted device) signed. Changing the
  recovery key is a signed S29 event; S27 offers only the local `ring.replaceRecoveryKey(publicKeys)`.

### Key storage

- `KeyStore` adapters: `createSafeStorageKeyStore(safeStorage, files)` (desktop; refuses Linux
  `basic_text`) and `createSecureStoreKeyStore(sodium, secureStore, files)` (mobile). Names:
  `[A-Za-z0-9._-]{1,128}`. `saveKeyring` / `loadKeyring` (loading checks the same invariants as a merge).
- Mobile: SecureStore holds ONE 32-byte key-encryption key with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`,
  chosen because background sync must read keys while the phone is locked; THIS_DEVICE_ONLY keeps it out
  of backups. Values are sealed under it and kept in files, so SecureStore's ~2048-byte value limit never
  applies however many generations a ring collects. Files without their KEK (restored elsewhere) report
  `keystore_unavailable`.

## Decisions for the reviewer

- **HKDF, not Argon2id, for the recovery key**: the words carry 256 random bits, so stretching adds
  nothing. Argon2id is needed only if a user-chosen passphrase is ever added.
- **Vault id** is 16 random bytes (hex), never the profile slug, so a relay or synced folder learns no
  profile names.
- **libsodium-wrappers, not sumo**: the standard build has every function used
  (`crypto_box_seed_keypair`, `crypto_box_seal_open`, keyed `crypto_generichash`, the XChaCha20-Poly1305
  AEAD); sumo only adds unused primitives (Argon2id among them), so the smaller surface wins.
- **Narrow error mapping**: only the libraries' exact authentication-failure messages become
  `auth_failed`; a TypeError, a missing binding or "not yet implemented" is `unsupported_runtime`, so a
  broken runtime is never reported as tampered data. The self-test checks that the auth-failure mapping
  works on the running library.
- **Secrets** (`Secret`, `Keyring`, `BoxKeyPair`, identities, the gid salt) print `[redacted]` through
  `String`, `JSON.stringify` and `util.inspect`, and `structuredClone` (IPC) of them carries no key
  bytes; error messages are fixed strings and never carry a `cause`. `nolog.test.ts` checks it and a test
  fails if any crypto source calls `console`. JS cannot guarantee zeroing (m7): GC copies, immutable
  strings (safeStorage takes base64 strings, the recovery phrase is a string by necessity) and libsodium's
  WebAssembly buffers are freed without zeroing; `wipe()` and the `fill(0)` calls are best effort.
- **OS key storage (m12)**: Windows DPAPI, the macOS Keychain and Electron `safeStorage` decrypt for any
  code running as the user (or inside the app). That is within this threat model (a local attacker with
  the user's session already has the data) and is written down here on purpose.
- **Padding (m9)**: compression before encryption leaks compressibility; Padme bounds the size leak to
  O(log log n) bits at under 12% overhead, which makes the impractical CRIME-style import attack worse
  still.
