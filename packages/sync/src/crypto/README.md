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
Generations run 1..2^31 - 1 and epochs 0..2^20; one generation holds at most
`MAX_KEYS_PER_GENERATION` (8) keys. Payloads are encoded key by key (no argument spread), so every ring
the acceptance policy admits can be saved and wrapped (a 50k-key ring encodes, pairs and rotates in a
test).
Every signature has its own context (`"cashu/wrap/v3"`, `"cashu/cert/v1"`, and for S29's statements
`"cashu/registry/v1"`, `"cashu/lease/v1"`, `"cashu/pairing/v1"`); no context is a prefix of another, an
unknown context is refused (`RangeError`), and nothing signs raw caller bytes. `verifyContextSignature`
checks `context | body`; `verifySignature` is the raw strict check. S28d frame signatures must add a
new context that neither extends nor is a prefix of these (for example `"cashu/frame-sig/v1"`).

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
  checked before decrypting (`key_not_allowed`). A revoked device can write under ANY device id (the
  frame AAD names the writer but only a key authenticates it), so the floor applies to every writer id:
  after a revocation, frames under a generation below the revocation key are rejected from every
  writer once that writer has written at the new generation. Between the revocation and a writer's
  first frame at the new generation the floor cannot tell a revoked device from that writer; only
  per-device frame signatures (S28d) close that window.
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
- **Revocation depends on freshness**: storage colluding with a revoked device can withhold the
  revocation and its rotation wraps from an honest device indefinitely, and that device keeps wrapping
  new keys for the revoked one. Revocation is effective only once S28b / S28d signed heads let a device
  detect what it has not seen.

### S29 (pairing, registry, rotation, revocation)

- Each device has a `DeviceIdentity` (`createDeviceIdentity`): an X25519 box key and an Ed25519 signing
  key, stored with `saveDeviceIdentity` / `loadDeviceIdentity`. Other devices learn its public keys ONLY
  from verified certificates (below), never from a registry file in storage.
- **Pairing, first hop only**: `sealForPairing(ring, newDeviceBoxPk)` /
  `openPairingWrap(sealed, device, vaultId, expectedHash)`, where `expectedHash` is the
  `pairingWrapHash(sealed)` both devices compared through the SAS or commitment; any other box is
  refused before opening (`auth_failed`), so the comparison cannot be forgotten. A sealed box
  authenticates nothing about its sender, so S29 must guarantee: the desktop seals only for a public key
  it authenticated (QR scanned in person, or a short authentication string); the SAS covers both
  devices' public keys, the vault id, the recovery public keys and the hash of the wrap, with
  commit-then-reveal so a man in the middle cannot grind a 6-digit (20-bit) SAS; the new device learns
  the registry root (owner device signing keys) from that same authenticated exchange. The payload
  carries the recovery public keys and the gid salt, which is how they get pinned on the new device.
- **Every later wrap is signed**: `wrapKeys(ring, sender, recipient, kids?, recipients?)` and
  `unwrapKeys(wire, recipient, ring | {vaultId, recoveryPublicKey}, trustedSigner, { acceptEpoch })`;
  `acceptEpoch` is a required argument. `recipient` must be a `TrustedDevice` from `verifyCertificates`
  (its box key is the certified one) or `recoveryRecipient(ring)`, both bound to their vault (another
  vault's ring is `vault_mismatch`) with key bytes that cannot be changed in place; S29 seals rotations
  only for those, so storage cannot swap in its own box key.
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
  only pairing, recovery's base wrap and the local store carry a whole ring. "Merging rings is a union"
  is NOT the rule.
- **Rotation / revocation**: `rotateKeyring(ring, { epoch })`, where epoch = the number of revocation
  events the rotator has applied: from the active key's epoch up to the highest held + 1 (revoking
  several devices at once is one event, epoch + 1). `active` is the highest (epoch, generation, kid):
  epoch first, so a device that never saw a revocation cannot override the revocation key by rotating
  past its generation at a lower epoch.
  Revoking = rotate with epoch + 1 and wrap the new kid for every remaining device and for
  `recoveryRecipient(ring)`, listing them all as `recipients`. A concurrent plain rotation at the same
  generation has the lower epoch and loses. A malicious device that is still trusted can claim at most
  epoch + 1 (`epoch_gap` beyond), and at epoch + 1 it ties the revoker and can grind its kid to win.
  So `acceptEpoch(sender, entry)` is REQUIRED for every unwrap except pairing: it refuses an epoch above
  the sender's revocation count in the signed registry (`untrusted_sender`). Under epoch-first order,
  `acceptEpoch` is the ONLY guard on `active`: the acceptance policy admits any generation up to the
  highest + 1, generation 1 included, so a trusted sender's key at epoch + 1 becomes active over every
  later generation unless `acceptEpoch` refuses an epoch above that sender's signed revocation count.
  **S29 rule for what remains**: after merging, if the active key's sender is revoked, or its signed `recipients` include a
  device revoked in the merged registry, rotate again with epoch + 1.
- **Ring growth by a still-trusted device (MA1)**: a stolen device not yet revoked holds every key
  anyway, and can sign one wrap per new generation. Each costs the victim one merge, linear in ring
  size (about 2 ms per wrap on a small ring, 37 ms at 100k keys), and growth is permanent because keys
  are never dropped; 2^31 generations cannot be exhausted, so rotation and revocation always remain
  possible, and any ring encodes. The bound is memory and storage (40 bytes per key). The per-device
  rotation rate limit belongs in S29's `acceptEpoch(sender, entry)`, which sees the sender and the whole
  entry (generation included), so it is enforced at unwrap time, not flagged afterwards: refuse a
  sender's key beyond its allowance (for example a few rotations per day), treat a burst as grounds to
  revoke, and then rotate.
- **Per-generation cap as a lever**: a still-trusted malicious device can fill generation n + 1 with 8
  keys so the revoker's key at n + 1 is refused (`bad_payload`) on that device. The revoker's next
  rotation at n + 2 is accepted, so the S29 rule "rotate again" recovers; S29 must treat a refused
  revocation wrap as a reason to rotate again.
- **Device certificates (trust root)**: `certifyDevice(signer, {deviceId, signPublicKey, boxPublicKey},
  vaultId)` and `verifyCertificates(vaultId, recoverySignPublicKey, certs, revoked)` ->
  `{ devices: Map<deviceId, TrustedDevice>, conflicts }`, where `TrustedDevice` carries the certified
  signing AND box keys and its `issuers`. `revoked` (required) is S29's set from the signed registry.
  At vault creation, while the words are on screen, `createVaultWithRecovery(recoveryIdentity, creator)`
  makes the ring, the creator's certificate and the recovery-signed base wrap; every paired device is
  certified by an already trusted device.
  A device is trusted only through a chain rooted at the recovery signing key; storage cannot add one.
  **Conflicts fail closed**: if valid chains give one device id two different key pairs (a certified
  device certifying its own key under an honest id), that id is untrusted, reported in `conflicts` for
  the app to show, and passes no trust on; order, chain depth and id order never pick a winner. The
  cost is a visible denial of service on that id, which a trusted device could cause anyway.
  **Revoking a device revokes its certificate subtree**: a revoked id is untrusted and passes no trust
  on, so a device vouched for only through it (including any id it certifies after its revocation;
  certificates carry no time) is untrusted. Honest devices it paired must be re-certified by a trusted
  device; a device also certified on another trusted path keeps its trust.
- **Recovery**: `createRecoveryKey` -> `{ phrase, publicKeys }`, where `phrase` is a `RecoveryPhrase`
  that prints `[redacted]` and gives the words only through `reveal()`; `createKeyring(sodium,
  publicKeys)` pins them. `recoveryIdentity(phrase)` signs as `RECOVERY_SIGNER_ID`. A recovering device
  seeds its ring ONLY from the recovery-signed base wrap (`unwrapKeys` into `{vaultId,
  recoveryPublicKey}` refuses any other signer with `untrusted_sender`), so the base ring and the gid
  salt come from the words, never from a certified device that may since have been stolen; device
  wraps then extend it one generation at a time. It builds
  `trustedSigner` from the recovery signing key plus `verifyCertificates` over the certificates stored
  next to the wraps, NEVER from a registry file in storage (storage can withhold revocations). After
  restoring it must at once rotate with an epoch above every epoch seen, treat every pre-recovery device
  as revoked, and re-pair the devices the owner still has. Changing the recovery key is a signed S29
  event; `ring.replaceRecoveryKey(publicKeys)` exists only to apply that verified event locally, never
  with keys read from storage. Rings from raw key material (`keyringFromKeys`) exist only on
  `@cashu/sync/testing`, for tests and vectors.
- **S29 notes from the final review (n1-n3)**:
  - n1 (implemented in S29b, `devices/recoveryChange.ts`): `device.recoveryChanged` carries a new
    recovery-signed base wrap (the whole ring as of the change, signed by the NEW recovery identity, with
    `createVaultWithRecovery`'s shape, checked with `verifyWrapSignature` by devices that cannot open
    it), certificates by the new identity for every trusted device, and the eids of old-key statements
    that keep counting. It is signed by a trusted device AND authorized by the OLD recovery identity, so
    neither a stolen device alone (which could otherwise move the root to words its thief holds and make
    every revocation of it worthless) nor leaked old words alone can move the root. Each device pins the
    new keys locally (`replaceRecoveryKey`) and never goes back; `unwrapKeys(..., { previousRecoveryKeys })`
    merges wraps a sender made before it applied the change.
  - n2: `acceptEpoch` is also where the per-sender rotation rate limit lives (see ring growth above).
  - n3: a recovering device has no signed revocation count. Its `acceptEpoch` accepts only epochs up to
    the highest epoch seen in recovery-wrapped keys + 1, and it must rotate before writing any frame.
    Otherwise a stolen, still-certified device can climb one epoch per wrap toward `MAX_EPOCH` (2^20),
    where the mandated "rotate above every epoch seen" would throw (impractical, about a million wraps,
    but unbounded).

### S29b (review fixes): what devices/ relies on from crypto

- `CertificateIndex` (cert.ts) parses a vault's certificates once; `closure(excluded)` is a breadth-first
  search (linear in certificates), `verify(revoked)` resolves conflicts exactly like
  `verifyCertificates` (which now delegates to it), `CertificateClosure.certifiedKeysOf(id)` gives a cut
  device's key (what verifies its statements before its cut), `maxDevices` admits at most that many ids
  breadth first, and a shared `CertificateCache` remembers every signature check across folds (bounded,
  oldest dropped first). `parseCertificate`, `isSignedBy` and `wrapSenderId` read without trusting.
- Residual risks the registry documents (devices/registry.ts, revocations.ts): positions cannot tell who
  revoked first, so a revoked device that revokes its revoker after its cut takes it down too (fail
  closed; the owner's recovery words raise the honest device's cut and re-certify); a rewrite of a
  device's own pre-cut frame is only seen by devices that read it (fresh joiners, rebuilds) until S28d
  signed heads; a revoked device can still forge a trusted writer's frames at positions that writer has
  not reached until it writes at the new key (S28d per-device frame signatures).
- Device-limit crowding (S29c review, minor): `maxDevices` (MAX_DEVICES = 1024) admits ids breadth first,
  each BFS level sorted by key. A still-trusted malicious device can certify 64 puppets
  (MAX_CERTS_PER_ISSUER), each writing under its own id and certifying 64 more: about 4096 nodes at one
  depth, which crowd out honest devices at that depth or deeper (pairing chains deepen over the years
  when each new phone is paired by the last one). Mitigation today: the existing caps bound the tree
  (64 certificates counted per issuer, per writer stream; at most CERT_CHECK_BUDGET checked; 1024 ids
  admitted), and revoking the device cuts its whole certificate subtree, which frees the slots on every
  device at the next fold. Follow-up: admit by trusted-path depth with a per-issuer share, or cap a
  subtree's size per first-level issuer.
- Catch-up waivers (S29c): a trusted device can waive another device's catch-up requirement with the
  `typed` confirmation, because the expected text (the short ids) is computable; the typed text
  protects against ACCIDENTAL waivers only. The recovery-signed waiver is the security path: only the
  words authorize it against a stolen or buggy device. A waiver by a writer that is later revoked or
  conflicted is refused (the requirement reappears: fail closed).

### S29c: decision keys (the invariant behind every revocation decision)

Invariant: under a revocation set R (each fixpoint step's assumed set, and the final one), a key may
back a revocation decision only if it is a DECISION KEY (devices/decisionKeys.ts, the one function every
acceptance site calls): a key pair certified for the device through a chain of certificates that
starts at the recovery key (the creator's certificate is recovery-issued) and passes only through
devices outside R. For a revoked device that is the key a device outside R certified for it, never a
certificate it issued itself. Acceptance sites: revocation eligibility and the M1 attestations that
raise cuts (lease watermarks, `prev` links, earlier revocations; devices/revocations.ts, per step),
the keys of a revoked device (`Revocation.signPublicKeys`), and through `Registry.statementKeys` every
lease event, watermark, waiver writer, recovery change and name.

Revocation CONSENTS (H2) use decision keys too, under the words' revocations only (they must not
depend on the device revocations being decided), minus every key whose chain needs the revocation's
signer (H5'): a key minted later can neither void a genuine consent nor forge one.

Enforcement: devices/acceptance.ts is the ONE place in devices/ that checks a signature; its key
sources are decision keys (`device`, `statement`, `consent`), the recovery root, the certificate
being admitted (certificate admission builds the closure decision keys come from), and the invite
the owner scanned while pairing. devices/acceptance.guard.test.ts fails when any other file there
calls a raw verifier (directly, through a member or private field, `.call` / `.apply` / `.bind`, or
an alias), and proves itself on planted violations.

Why this closes the class (P2, V1, V2 and every longer chain): to raise its own cut, or to make any
statement count for it, a revoked device X needs a key the fold accepts for a device other than
itself, or a second key for itself. Any key X can mint is certified by X or by a device below X (a
puppet it certified, at any depth, at any position, genuine or written into a rewritten old frame).
Every such chain passes through X. In every fixpoint step that assumes X revoked, those keys are not
decision keys, so they verify nothing: no attestation, no revocation, no lease statement. The steps
that do not assume X revoked are exactly those in which X's own statements count anyway (the grounded
fixpoint's upper bound), and the fail-closed result takes the revocations counted in any consistent
reading, so minted keys can at most add revocations, never remove one, raise a cut or add trust. What
remains are keys of devices outside R: a still-trusted device can mint (and is stopped by revoking
it), and a rewrite of an honest device's frame needs that device's key (signed heads, S29c phase B).
Tests: devices/attestation.test.ts (P2, V1, V2, chains of length 3, controls) and the random
certification-graph property (devices/decisionKeysProperty.ts, default seeds in decisionKeys.test.ts,
the sweep in decisionKeys.property.exhaustive.test.ts).

### S29c: who may revoke a device (H2, lead decision; a protocol rule)

- A device that is NOT in the owner's hands (lost, stolen) is revoked with the recovery words: a
  recovery-signed revocation needs nothing else, can never be contested or retaliated against, and
  its re-certifications are recovery-issued.
- A device-signed revocation of ANOTHER device counts only with that device's consent
  (`consentToRevocation` on the target: its signature over the vault, the revocation's eid, the
  entries with their cuts, and the revoker). The owner confirms on the device being retired, which is
  therefore in the owner's hands. A device may always revoke itself.
- The consent verifies only with a decision key of the target whose chain neither needs the
  revoker (nor anything it certified, at any depth) nor a device the words revoked (review H5';
  `keysAvoiding`, consent.ts). So the revoker can never vouch for its own victims: a revoked device
  that mints keys for them, alone, through a puppet or through an accomplice revoked with the words,
  forges nothing. Consequence for the UI: a device cannot retire, on consent, a device it paired
  (directly or below); the owner uses another device, retires the device on itself, or the words.
- The consent keys also avoid every RETIRED device (H5''): revoked with the words, or retired by a
  revocation its targets genuinely consented to, computed to a fixpoint (consent.ts
  `retiredDevices`; junk can never retire an honest device, which would need its genuine consent).
  An old phone retired on consent and later sold therefore mints nothing that counts.
- Retiring wipes: the device being retired (`VaultDevices.consentToRetirement`, or a self-retirement
  once its batch is written) wipes its vault keys and identity in memory. S44 contract: the app then
  deletes them from its KeyStore and shows the device as retired; nothing on it can read the vault
  or sign for it again.
- Self-retirement (lead decision: kept). A device may revoke itself without consent; every fold fixes
  the cut at the self-revocation's own position, so a stolen device cannot erase its history by
  stating an earlier cut. A device that paired others cannot rescue them itself: the orphans the
  owner chooses to keep need the words on a trusted device or a sibling retiring it with its consent
  (`consentToRetirement` on it), which re-certify them in the revocation's batch; the others stay
  untrusted, listed for re-pairing.
- Any other device-signed revocation is refused by every device's fold (`no_consent`), and the flow
  refuses to write it (`authority_required`).
- Consequences: a revoked or stolen device can no longer retaliate (review H5: its revocations need
  its victims' consent), so a revocation never takes down its revoker or anyone else's subtree; a
  stolen device revoked with the words, and every puppet it paired, signs nothing that counts in any
  fold step (review H1: such signers are skipped before any signature work).
- Residual: a still-trusted (stolen, not yet revoked) device can certify a second key pair for
  another device and forge that device's consent; the target is then conflicted (untrusted) anyway.
  Revoking the thief with the words ends it.
- Residual (phase B): a forged self-revocation of an honest device, written into a REWRITTEN early
  frame of its stream with a key minted for it, can still make it undecided (both it and its
  revoker revoked, fail closed) with its history after that position cut. That is the A1b rewrite
  class; signed heads close it, and the fixed self-revocation cut already caps it at the rewritten
  position.

### S29c: asking for the recovery words (S44 UX rule)

H2 makes typing the words a routine step, and whoever sees them holds the vault's root. The UI asks
for them ONLY on a device the owner already trusts, never on the device being retired or on any
device the owner suspects; and when any device that ever saw the words is suspect, it offers a
recovery-key change (new words) right away.

### S29c: the revoke flow (contract for the S44 UI)

`VaultDevices.prepareRevocation(targets, { revoke, rotate, recertify }, authority?, selection?)`
(devices/rotation.ts): `authority` = the recovery identity, or `{ consent: { [target]: signature } }`
from the targets; `selection` = `{ recertify: [device ids] }`, the orphans the OWNER chose to
re-certify (review W1, lead decision: default none).

- It returns ONE batch to write (`change.events`, then `change.commit()`): the `device.revoked`, a
  `device.added` re-certification of each CHOSEN orphan (certified by this device, or by the recovery
  identity when it is given), and the key rotation wrapped for the devices trusted afterwards. An
  orphan not chosen stays untrusted and nothing is sealed for it.
- `change.affected` lists EVERY orphan (a remaining device whose only valid chain ran through a
  target): `{ device, name, pairedBy, pairedAt: { position, hlc }, suggested, recertified, reason? }`,
  `reason` = `not_selected`, `capacity` (the writer's certificate window, 64 per issuer and stream, is
  full) or `recovery_required`. Re-certification is never automatic: revoking a stolen device with
  the words must not revive what the thief paired (W1: a recovery-signed certificate and the new data
  key for the thief's "iPad").
- S44 UX: the UI shows each orphan with its name, who paired it and when, as a checkbox list. On the
  words path (lost or stolen) every box starts UNCHECKED (`suggested: false`); the owner checks only
  devices it recognises and holds. On the consent path (the target is in the owner's hands) the UI may
  pre-check them (`suggested: true`). It then calls again with the chosen ids; unchecked devices are
  shown as "must be paired again".
- `{ ok: false, reason: "authority_required", unconsented }`: a target (not this device) has neither
  consented (with a key that counts: not one this device vouches for, see H5') nor is the recovery
  identity given. The UI asks: is the device in your hands (confirm on it, then retry with its
  consent) or lost / stolen (enter the recovery words)? Lost or stolen is the default answer.
- `{ ok: false, reason: "recovery_required", affected }`: this device's own chain runs through a
  target (for example a phone the target paired, revoking it: review H4; with the words it must also
  choose itself), or it revokes itself and the owner chose orphans to keep, so only the words (or a
  sibling, with this device's consent) can re-certify. Nothing is written.
- Atomicity: the revocation names its re-certifications (`recertify`: their eids) and the registry
  counts it only once all of them are held at its position (`incomplete_batch` until then). The
  engine applies a frame group only when complete (events.md 5), and even a delivery that stops
  inside the batch (a truncated frame, a partial group, storage dropping the tail) can delay the
  revocation, never revoke without re-certifying.

### S29c: the pinned fetch leader (R4, lead decision D3 / D4; contract for the S44 UI)

Rule 6 (one PSD2 fetcher per vault) must not rest on an unstated linearizable remote. It rests on
exactly one of (devices/lease.ts header, events.md 8.11):

- **(a) mode pinned**, the default on EVERY backend: exactly one designated device, the creator from
  vault creation on (its recovery-signed pin is the lease chain's root, written next to its
  `device.added`). The leader changes only by an explicit owner action, a `lease.pinned` statement
  signed by a device after the owner typed the confirmation (`pinConfirmationText`) or signed by the
  recovery words, and the new leader acts only after the old one acknowledged (`pendingFrom`, a
  `lease.released`). Every signature goes through the single gate (devices/acceptance.ts): `statement`
  keys for a device-signed pin (a revoked device's pins after its cut never count), `recovery` keys
  for a recovery-signed one (a replaced key only for pins its change ratified: `buildRecoveryChange`
  ratifies the chain's recovery pins, so a leaked old phrase pins nothing). Needs no propagation
  bound: the old leader acknowledges only after it saw the pin, and from then on it never acts.
- **(b) mode auto**, an owner opt-in pin: claims, renewals and the settle period, used by a device
  only while its transport declares bounded propagation (carrier.ts `Transport.consistency`; the
  engine's `leaseTransport()` is `bounded` only while every bounded remote was reachable in the last
  pass) and its config covers the bound: `settle >= skew + publish deadline + propagation`. A relay
  may declare `bounded` only when `checkPropagationClaim` (testing/propagation.ts, run by the carrier
  contract suite) passes for it; a Cloudflare variant must use strongly consistent storage (Durable
  Objects / R2), never KV. Folder transports declare `eventual`: over them nobody holds in this mode
  (`unsupported_transport`). All auto-mode devices must share the relay (a device on another relay is
  not covered by its bound).

The typed confirmation is an ACCIDENT GUARD, not an authorization (as for waivers): the text is
computable, so a stolen, not yet revoked device can pin itself. Revoking it (recovery words by default)
stops its later pins; a pin naming it then leaves the vault leaderless until the owner re-pins. A
force re-pin (D4) is the only way to two simultaneous leaders: an old leader that is in fact alive
and has not seen the pin may fetch once more (the property tests assert every overlap is exactly
that). Residual: a pin naming a device nobody knows (an owner mistake, or a stolen device) is valid
on the chain and leaves the vault leaderless (no fetching, never two fetchers) until a re-pin.

S44 UX:

- Settings > fetching shows the leader ("this Mac fetches from your banks"). "Make this device the
  fetcher" asks the owner to TYPE the short id shown (`pinConfirmationText`); the UI sets `text` only
  from what was typed. The recovery-words path is offered on a trusted device only (the words rule
  above).
- After a re-pin the new leader shows "waiting for <old device> to hand over" (`handover_wait`) and
  the old device writes its acknowledgement on its next sync by itself. The safe path comes first:
  wait, or revoke the old device. Only then the UI offers force, with the warning "if <old device> is
  still running somewhere, it may fetch once more" (`RepinAction.mayStillRun`) and a typed
  `<id> force`.
- Liveness (`leaderLiveness`, devices/liveness.ts): every device shows a warning when the pinned
  leader has not reported a fetch (`lease.fetched`, written by the leader after each completed fetch)
  for more than 36 hours, measured from its last report, else from its pin, never later than when
  this device first saw that event (a leader whose clock runs ahead cannot look fresh). States: `ok`,
  `silent`, `leaderless` (revoked or unknown leader: warn at once, no force needed), and
  `handover_pending` (warn after 36 hours, force offered naming the old leader). The warning carries
  the re-pin action (`candidates`, `force`, `mayStillRun`). The app suppresses it while the vault has
  no bank connection that fetches (nothing to miss) and checks it on each sync with the device clock.
- Automatic handover is offered only when a relay remote is configured and its declaration passed
  conformance; on a folder-only vault the toggle is not shown, and a device whose relay is offline
  shows "automatic handover needs the relay; pin a fetcher" (`unsupported_transport`).

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
  `keystore_unavailable`; a blob that does not open under the KEK reports `keystore_corrupt`, and so does a
  desktop blob that safeStorage or base64 cannot decode. Rolling a
  blob back to an older one of the same name is not detected (needs local access to the app's files).

## Decisions for the reviewer

- **HKDF, not Argon2id, for the recovery key**: the words carry 256 random bits, so stretching adds
  nothing. Argon2id is needed only if a user-chosen passphrase is ever added.
- **Vault id** is 16 random bytes (hex), never the profile slug, so a relay or synced folder learns no
  profile names.
- **libsodium-wrappers, not sumo**: the standard build has every function used
  (`crypto_box_seed_keypair`, `crypto_box_seal_open`, keyed `crypto_generichash`, the XChaCha20-Poly1305
  AEAD); sumo only adds unused primitives (Argon2id among them), so the smaller surface wins.
- **Failure classification by kind, never by message**: bindings word and wrap the same failure
  differently (react-native-libsodium's seal_open failure arrives on Android as "Exception in
  HostFunction: ..." with a stack), so `sodium.ts` never reads an error message. A throw from a
  well-formed `aeadDecrypt` / `sealOpen` (key, nonce and public-key lengths checked first; a malformed
  one is `unsupported_runtime`) is `auth_failed` only when the backend threw a plain `Error` (the kind
  libsodium, its JSI bindings and @noble raise), the boolean verify path in `verify.ts` (pure @noble:
  XChaCha20-Poly1305 tag, and the sealed box rebuilt from X25519 + HSalsa20 + BLAKE2b + XSalsa20-Poly1305,
  low-order ephemeral keys refused like libsodium) says the input does not authenticate, and the backend
  still opens a known-good input (probe). Anything else - a TypeError, an Error subclass, a non-Error
  value, a verify path or probe that throws, a throw on authentic input, a runtime that throws for
  everything - is `unsupported_runtime`, so a broken runtime is never reported as tampered data and
  tampered data on a working runtime never as a runtime fault. The verify paths run only on the failure
  path. The self-test checks that a tampered AEAD and a tampered box are recognised on the running
  library, that the verify paths agree with the known answers (including a box sealed by
  libsodium-wrappers), that two random draws differ and are not zero, and covers @noble's Ed25519 (RFC
  8032 test 1) and X25519 (must agree with libsodium's seed key pair). `sodium.classify.test.ts` covers
  the iOS, Android and unknown shapes.
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
