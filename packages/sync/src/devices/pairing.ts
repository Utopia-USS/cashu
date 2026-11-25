// QR pairing with a short authentication string (SAS) and commit-then-reveal.
//
// Roles: the inviter (a trusted device that holds the vault, usually the desktop) and the joiner
// (a fresh device identity, usually the phone). The QR is scanned in person, so it authenticates the
// inviter to the joiner; the SAS, compared by the owner on both screens, authenticates the joiner to
// the inviter. Every message travels over an untrusted `PairingLink` (relay, local network) and is
// sealed (crypto_box_seal) so the link learns nothing.
//
//   QR        inviter -> joiner   vault id, inviter id + signing key, ephemeral X25519 key, expiry
//   hello     joiner  -> inviter  joiner id, signing + box keys, name, clock, commit = H(... nonceN)
//   challenge inviter -> joiner   nonceD, clock, recovery public keys; signed by the inviter over T
//   reveal    joiner  -> inviter  nonceN (must open the commit)
//   SAS       the joiner shows 6 digits = H(T | nonceN); the owner TYPES them into the inviter,
//             which compares them with its own (the inviter never shows its SAS, so there is no
//             "looks the same, yes" button to press without looking at the phone); the step expires
//   welcome   inviter -> joiner   pairing wrap (sealForPairing), the joiner's certificate, the
//                                 first page of the registry events, their count and hash; signed
//                                 by the inviter over T | nonceN | wrap hash | cert | registry hash
//   pages     inviter -> joiner   the remaining registry events, PAGE_SIZE per message
//
// T is the transcript hash over the QR, hello and challenge fields (both devices' ids and public
// keys, the vault id, the recovery public keys, both clocks, the commitment and nonceD). The joiner
// commits to nonceN before it sees nonceD, so a man in the middle that substitutes its own keys must
// fix its SAS input before learning the inviter's: it matches the owner's comparison with
// probability 10^-6 per attempt and cannot grind. The inviter seals the keyring only after the
// owner confirmed the SAS. The pairing wrap's hash reaches the joiner inside the inviter's
// signature (the inviter's signing key came from the QR), over the transcript the SAS confirmed;
// `openPairingWrap` refuses any other box. The joiner learns the recovery public keys from the
// SAS-covered challenge and the registry root (trusted devices' signing keys) by folding the
// welcome's registry events against those keys. Clocks more than 5 minutes apart are refused
// (events.md 3.3). The first hello wins: any second or replayed message ends the session (the owner
// starts a new invitation), so someone who photographed the QR can at worst abort a pairing; under a
// man in the middle the owner's phone shows no code at all (it refuses the challenge signature).
//
// Files: pairingProtocol.ts (invite, hashes, sealed messages, registry pages), pairingInviter.ts,
// pairingJoiner.ts; pairingLink.ts runs either side over an untrusted message link.

export { type InviterOptions, type InviterWelcome, PairingInviter } from "./pairingInviter.js";
export {
  type JoinerOptions,
  type JoinerProgress,
  type JoinerWelcome,
  PairingJoiner,
  type PendingPairingSnapshot,
} from "./pairingJoiner.js";
export {
  DEFAULT_INVITE_TTL_MS,
  decodeInvite,
  encodeInvite,
  type Invite,
  MAX_REGISTRY_EVENTS,
  PAGE_SIZE,
  type PairingFailed,
  type PairingFailure,
  type PairingStep,
  SAS_ATTEMPTS,
  SAS_TTL_MS,
  shortAuthenticationString,
} from "./pairingProtocol.js";
