// The Firestore relay (M4-A): REST client, anonymous auth and the transport. Platform-free: only an
// injected `fetch`, so the Mac host and the phone share it.
export {
  AnonymousAuth,
  type AnonymousAuthOptions,
  type AuthRecord,
  type AuthStore,
  type IdentityEndpoint,
} from "./auth.js";
export {
  type CreateVaultOutcome,
  FirestoreRelayAdmin,
  type FirestoreRelayAdminOptions,
  type RecoverAdminOutcome,
  type RelayMember,
  type RelayRole,
  relayRecoveryHash,
} from "./relayAdmin.js";
export {
  type FirestoreEndpoint,
  FirestoreRest,
  FirestoreRestError,
  type FirestoreRestOptions,
  type TokenSource,
} from "./rest.js";
export {
  FirestoreTransport,
  type FirestoreTransportOptions,
  type RelayErrorKind,
  type RelayStatus,
} from "./transport.js";
