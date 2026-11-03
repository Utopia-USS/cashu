// @cashu/host-protocol/store: the store channel v5 (messages + JSON value codec), spoken by the
// desktop renderer's store client and the host's store service over `store` frames of a `ui` session, and the
// desktop relay's `link` messages (relay.ts).
export { decodeValue, encodeValue, type JsonValue, StoreCodecError, toJson } from "./codec.js";
export {
  type ErrorInfo,
  errorInfo,
  errorInfoSchema,
  idempotencyKeySchema,
  type RunOutcomeWire,
  runOutcomeSchema,
  STORE_PROTOCOL_VERSION,
  type StoreTarget,
  type StoreToClient,
  type StoreToHost,
  storeToClientSchema,
  storeToHostSchema,
  targetSchema,
} from "./messages.js";
export {
  LINK_STATES,
  type LinkMessage,
  type LinkState,
  linkMessageSchema,
  type RelayToClient,
  relayToClientSchema,
} from "./relay.js";
