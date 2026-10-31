# packages/sync/src/crypto (S27)

Encryption and keys for the sync log. Everything goes through one `Sodium` interface:
`loadNodeSodium()` on Node / Electron (`libsodium-wrappers-sumo`), `fromLibsodium(require("react-native-libsodium"))`
on mobile. Frames are also readable with `@noble/ciphers` (pure JS), proven in `vectors.test.ts`.

## Formats (frozen by golden vectors; a change needs a new version byte or tag)

| What        | Bytes                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Frame       | `0x01` \| key id (16) \| nonce (24) \| XChaCha20-Poly1305 ciphertext + tag (16)                                                |
| Frame AAD   | `"cashu/frame/v1"` \| `0x01` \| key id \| u32 len + vault id \| u32 len + device id \| u32 segment \| u64 offset (big-endian)  |
| Key id      | BLAKE2b-128 keyed by the data key over `"cashu/kid/v1"`, hex                                                                   |
| Key payload | `"cashu/keys/v1"` \| u32 len + vault id \| u16 count \| (u32 generation \| 32-byte key)*                                       |
| Wrap        | `crypto_box_seal(key payload, recipient X25519 public key)`                                                                    |
| Recovery    | 24 BIP39 words = 256-bit entropy -> HKDF-SHA256(salt `"cashu/recovery/v1"`, info `"x25519-seed"`) -> `crypto_box_seed_keypair` |

## What consumers rely on

- **S28b (carrier)**: `sealFrame` / `openFrame` per frame with `{vaultId, deviceId, segment, offset}`; the carrier adds the
  u32 length prefix and compresses before sealing. `frameKeyId` tells which key a frame needs before trying it.
  Errors are `CryptoError` with a `code`; a frame that fails is rejected, never partly applied.
- **S29 (pairing, revocation)**: `createDeviceKeyPair`, `wrapKeys(ring, pubkey, kids?)`, `unwrapKeys(wrap, pair, vaultId)`.
  A sealed box does not authenticate the sender: the pairing protocol must (QR + short authentication string).
  Revocation = `rotateKeyring` + `wrapKeys(..., [newKid])` for every remaining device and the recovery public key.
  Two devices rotating concurrently: the same generation, larger key id wins `active`; merging rings is a union.
- **Key storage**: `KeyStore` with `InMemoryKeyStore`, `createSafeStorageKeyStore(safeStorage, files)` (refuses Linux
  `basic_text`) and `createSecureStoreKeyStore(SecureStore)` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). Names: `[A-Za-z0-9._-]{1,128}`.

## Decisions for the reviewer

- **HKDF, not Argon2id, for the recovery key**: the words carry 256 random bits, so stretching adds nothing. Argon2id
  is needed only if a user-chosen passphrase is ever added.
- **Vault id** is 16 random bytes (hex), never the profile slug, so a relay or synced folder learns no profile names.
- **Secrets** (`Secret`, `Keyring`, `BoxKeyPair`) print `[redacted]` through `String`, `JSON.stringify` and `util.inspect`;
  error messages are fixed strings. `nolog.test.ts` checks both. JS cannot guarantee zeroing (GC copies, strings);
  `wipe()` and the `fill(0)` calls are best effort, and the recovery phrase is a string by necessity.
- **Not covered here**: frame length padding (sizes leak plaintext length), compaction, sender authentication of frames
  beyond "holds the vault key" (a device signing key arrives with the relay, S28d), the `react-native-libsodium`
  function set is assumed from its docs (verify `crypto_box_seed_keypair` on a device in S41/S44).
