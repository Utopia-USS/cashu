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

| What        | Bytes                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Subkeys     | `frameKey = BLAKE2b-256(key = data key, "cashu/subkey/frame/v2")`, `kidKey = BLAKE2b-256(key = data key, "cashu/subkey/kid/v2")`; the raw data key is used for nothing else    |
| Key id      | `hex(BLAKE2b-128(key = kidKey, "cashu/kid/v2" \| lp(vault id) \| u32 generation \| u32 epoch))`; always computed, never accepted                                               |
| Frame       | `0x02` \| key id (16) \| nonce (24) \| XChaCha20-Poly1305(frameKey) ciphertext + tag (16)                                                                                      |
| Frame AAD   | `"cashu/frame/v2"` \| `0x02` \| key id \| lp(vault id) \| lp(device id) \| u32 segment \| u64 offset                                                                           |
| Frame plain | u32 length \| data \| zero padding to Padme(length + 4); max 64 MiB of data                                                                                                    |
| Key payload | `"cashu/keys/v3"` \| lp(vault id) \| recovery box pk (32) \| recovery sign pk (32) \| gid salt (32) \| u32 count \| (u32 generation \| u32 epoch \| key 32)*                   |
| Signed wrap | `0x03` \| sender device id (16) \| Ed25519 signature (64) \| u16 count \| recipient ids (16 each) \| `crypto_box_seal(payload, recipient box pk)`                              |
| Wrap signed | `"cashu/wrap/v3"` \| lp(vault id) \| sender id \| recipient id \| recipient box pk \| u16 count \| recipient ids \| sealed                                                     |
| Certificate | `0x01` \| signer id (16) \| subject id (16) \| subject sign pk (32) \| subject box pk (32) \| Ed25519 signature (64) over `"cashu/cert/v1"` \| lp(vault id) \| the four fields |
| Pairing box | `crypto_box_seal(payload, new device box pk)` (first hop only, see below)                                                                                                      |
| Device blob | `"cashu/device/v2"` \| device id (16) \| box secret key (32) \| Ed25519 seed (32); public keys recomputed on load                                                              |
| Mobile blob | `0x01` \| nonce (24) \| XChaCha20-Poly1305(Keychain KEK, AAD = `0x01` \| item name)                                                                                            |
| Recovery    | 24 BIP39 words = 256-bit entropy -> HKDF-SHA256(salt `"cashu/recovery/v2"`): info `"x25519-seed"` -> `crypto_box_seed_keypair`, info `"ed25519-seed"` -> Ed25519 seed          |

Ids: vault id and device id are 16 random bytes as 32 lowercase hex characters (`createVaultId`,
`createDeviceId`), validated everywhere. The all-zero id is `RECOVERY_SIGNER_ID`, never a device.
Generations and epochs are bounded to 1..2^20 and 0..2^20; one generation holds at most
`MAX_KEYS_PER_GENERATION` (8) keys, so every ring the acceptance policy admits can be saved and wrapped.
Every signature has its own context (`"cashu/wrap/v3"`, `"cashu/cert/v1"`); S28d frame signatures must
use another one, and nothing signs raw caller bytes.

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
  key, stored with `saveDeviceIdentity` / `loadDeviceIdentity`. Other devices learn its public keys ONLY
  from verified certificates (below), never from a registry file in storage.
- **Pairing, first hop only**: `sealForPairing(ring, newDeviceBoxPk)` / `openPairingWrap`. A sealed box
  authenticates nothing about its sender, so S29 must guarantee: the desktop seals only for a public key
  it authenticated (QR scanned in person, or a short authentication string); the SAS covers both
  devices' public keys, the vault id, the recovery public keys and the hash of the wrap, with
  commit-then-reveal so a man in the middle cannot grind a 6-digit (20-bit) SAS; the new device learns
  the registry root (owner device signing keys) from that same authenticated exchange. The payload
  carries the recovery public keys and the gid salt, which is how they get pinned on the new device.
- **Every later wrap is signed**: `wrapKeys(ring, sender, recipient, kids?, recipients?)` and
  `unwrapKeys(wire, recipient, ring | {vaultId, recoveryPublicKey}, trustedSigner, { acceptEpoch })`.
  `recipient` must be a `TrustedDevice` from `verifyCertificates` (its box key is the certified one) or
  `recoveryRecipient(ring)`; S29 seals rotations only for those, so storage cannot swap in its own box key.
  `trustedSigner(id)` returns the signing key of a device that is certified, registered and NOT revoked
  (S29's registry), else undefined (`untrusted_sender`). The signature is checked before opening
  (`auth_failed`). `unwrapKeys` returns `{ ring, senderDeviceId, recipients }`, where `recipients` is
  the signed list of every device (and `RECOVERY_SIGNER_ID`) the sender wrapped this rotation for; the
  rotator passes the full list in every wrap of one rotation. The list is the SENDER's claim (a malicious
  sender can leave itself out), so S29 must also persist kid -> `senderDeviceId` for every unwrapped key;
  the ring does not record it.
- **Acceptance policy** (`Keyring.merge`, used by every path that adds keys): same vault id
  (`vault_mismatch`), same pinned recovery keys (`recovery_key_mismatch`), same gid salt
  (`gid_salt_mismatch`), and new keys taken in ascending (generation, epoch, kid) with each generation
  at most one above the highest held (`generation_gap`), each epoch at most one above the highest held
  (`epoch_gap`; an empty ring takes its first key's epoch as the base) and at most 8 keys per generation
  (`bad_payload`). Any violation rejects the whole merge. A signed wrap into an existing ring may add at
  most ONE new generation, so a device that missed rotations applies their wraps in generation order;
  only pairing, recovery's first wrap and the local store carry a whole ring. "Merging rings is a union"
  is NOT the rule.
- **Rotation / revocation**: `rotateKeyring(ring, { epoch })`, where epoch = the number of revocation
  events the rotator has applied: from the active key's epoch up to the highest held + 1 (revoking
  several devices at once is one event, epoch + 1). `active` is the highest (generation, epoch, kid).
  Revoking = rotate with epoch + 1 and wrap the new kid for every remaining device and for
  `recoveryRecipient(ring)`, listing them all as `recipients`. A concurrent plain rotation at the same
  generation has the lower epoch and loses. A malicious device that is still trusted can claim at most
  epoch + 1 (`epoch_gap` beyond), and at epoch + 1 it ties the revoker and can grind its kid to win.
  So `acceptEpoch(sender, entry)` is REQUIRED for every unwrap except pairing: it refuses an epoch above
  the sender's revocation count in the signed registry (`untrusted_sender`). **S29 rule for what
  remains**: after merging, if the active key's sender is revoked, or its signed `recipients` include a
  device revoked in the merged registry, rotate again with epoch + 1.
- **Per-generation cap as a lever**: a still-trusted malicious device can fill generation n + 1 with 8
  keys so the revoker's key at n + 1 is refused (`bad_payload`) on that device. The revoker's next
  rotation at n + 2 is accepted, so the S29 rule "rotate again" recovers; S29 must treat a refused
  revocation wrap as a reason to rotate again.
- **Device certificates (trust root)**: `certifyDevice(signer, {deviceId, signPublicKey, boxPublicKey},
  vaultId)` and `verifyCertificates(vaultId, recoverySignPublicKey, certs)` ->
  `{ devices: Map<deviceId, TrustedDevice>, conflicts }`, where `TrustedDevice` carries the certified
  signing AND box keys.
  At vault creation, while the words are on screen, the recovery identity certifies the creating device
  (and signs the first recovery wrap); every paired device is certified by an already trusted device.
  A device is trusted only through a chain rooted at the recovery signing key; storage cannot add one.
  **Conflicts fail closed**: if valid chains give one device id two different key pairs (a certified
  device certifying its own key under an honest id), that id is untrusted, reported in `conflicts` for
  the app to show, and passes no trust on; order, chain depth and id order never pick a winner. The
  cost is a visible denial of service on that id, which a trusted device could cause anyway.
  **Known gap, owner S29**: revoking a certified device needs the signed registry; until then a revoked
  device's certificate still validates.
- **Recovery**: `createRecoveryKey` -> `{ phrase, publicKeys }`; `createKeyring(sodium, publicKeys)` pins
  them. `recoveryIdentity(phrase)` signs as `RECOVERY_SIGNER_ID`. A recovering device builds
  `trustedSigner` from the recovery signing key plus `verifyCertificates` over the certificates stored
  next to the wraps, NEVER from a registry file in storage (storage can withhold revocations). After
  restoring it must at once rotate with an epoch above every epoch seen, treat every pre-recovery device
  as revoked, and re-pair the devices the owner still has. Changing the recovery key is a signed S29
  event; S27 offers only the local `ring.replaceRecoveryKey(publicKeys)`.

### Key storage

- `KeyStore` adapters: `createSafeStorageKeyStore(safeStorage, files)` (desktop; refuses Linux
  `basic_text`) and `createSecureStoreKeyStore(sodium, secureStore, files)` (mobile). Names:
  `[A-Za-z0-9._-]{1,128}`. `saveKeyring` / `loadKeyring` (loading checks the same invariants as a merge).
- Mobile: SecureStore holds ONE 32-byte key-encryption key with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`,
  chosen because background sync must read keys while the phone is locked; THIS_DEVICE_ONLY keeps it out
  of backups. Values are sealed under it and kept in files, so SecureStore's ~2048-byte value limit never
  applies however many generations a ring collects. Getting or creating the KEK is single flight, so
  concurrent first writes share one KEK. That holds within one JS runtime: an iOS background task in a
  separate runtime could still race on the very first run; "adopt what is stored after writing" covers
  it except for a blob the losing runtime wrote between its write and its re-read. Files without their KEK (restored elsewhere) report
  `keystore_unavailable`; a blob that does not open under the KEK reports `keystore_corrupt`. Rolling a
  blob back to an older one of the same name is not detected (needs local access to the app's files).

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
  works on the running library, and covers @noble's Ed25519 (RFC 8032 test 1) and X25519 (must agree
  with libsodium's seed key pair). Follow-up before S29 wires mobile: confirm react-native-libsodium's
  failure strings on a device build; if they differ the self-test fails closed (`unsupported_runtime`).
- **Padme** is computed with integer bit lengths (`Math.clz32`), never `Math.log2`, so Hermes and V8
  produce identical frame sizes (checked against a BigInt reference).
- **Secrets** (`Secret`, `Keyring`, `BoxKeyPair`, identities, the gid salt) print `[redacted]` through
  `String`, `JSON.stringify` and `util.inspect`, and `structuredClone` (IPC) of them carries no key
  bytes; error messages are fixed strings and never carry a `cause`. `nolog.test.ts` checks it, and Biome's
  `noConsole` (an override for this folder in the root `biome.json`) fails lint on any `console` call. JS cannot guarantee zeroing (m7): GC copies, immutable
  strings (safeStorage takes base64 strings, the recovery phrase is a string by necessity) and libsodium's
  WebAssembly buffers are freed without zeroing; `wipe()` and the `fill(0)` calls are best effort.
- **OS key storage (m12)**: Windows DPAPI, the macOS Keychain and Electron `safeStorage` decrypt for any
  code running as the user (or inside the app). That is within this threat model (a local attacker with
  the user's session already has the data) and is written down here on purpose.
- **Padding (m9)**: compression before encryption leaks compressibility; Padme bounds the size leak to
  O(log log n) bits at under 12% overhead, which makes the impractical CRIME-style import attack worse
  still.
