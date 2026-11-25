// `@cashu/sync/crypto`: the crypto core plus the recovery phrase (24 BIP39 words). Code that never
// shows or reads the words (the engine, the registry, the phone) imports `./core.js` instead, so the
// wordlist stays out of the phone bundle.
export * from "./core.js";
export {
  createRecoveryKey,
  type NewRecoveryKey,
  normalizePhrase,
  RECOVERY_WORDS,
  RecoveryPhrase,
  recoveryIdentity,
} from "./recovery.js";
