// @cashu/host-protocol/store: the store channel v2 (messages + JSON value codec), spoken by the
// desktop renderer's store client and the host's store service over `store` frames of a `ui` session.
export { decodeValue, encodeValue, type JsonValue, StoreCodecError, toJson } from "./codec.js";
export {
  type ErrorInfo,
  errorInfo,
  errorInfoSchema,
  idempotencyKeySchema,
  STORE_PROTOCOL_VERSION,
  type StoreTarget,
  type StoreToClient,
  type StoreToHost,
  storeToClientSchema,
  storeToHostSchema,
  targetSchema,
} from "./messages.js";
