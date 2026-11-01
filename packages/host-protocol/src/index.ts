// @cashu/host-protocol: the protocol between the local host process (one per data dir) and its
// clients (Electron main, the `cashu` shim for CLI and MCP, tests). Platform free: frames are bytes,
// nonces come in as parameters; the socket, files and randomness live in @cashu/node-host.
// The store channel v2 (JSON value codec, idempotency keys) is the `./store` subpath.
export {
  type AdminStatus,
  adminStatusParamsSchema,
  adminStatusResultSchema,
  adminStopParamsSchema,
  adminStopResultSchema,
} from "./admin.js";
export { DISCOVERY_FORMAT, discoverySchema, type HostDiscovery } from "./discovery.js";
export {
  encodeFrame,
  FrameError,
  type FrameErrorReason,
  FrameReader,
  MAX_FRAME_BYTES,
} from "./frames.js";
export {
  type AuthOutcome,
  type AuthReplyOutcome,
  answerChallenge,
  answerHello,
  type ChallengeOutcome,
  type ClientProofInput,
  checkAuth,
  clientProof,
  formatNonce,
  formatToken,
  type HelloInput,
  type HelloOutcome,
  type HostIdentity,
  type HostInfo,
  type HostProofInput,
  hostProof,
  makeHello,
  type PendingAuth,
  parseToken,
  proofsEqual,
  readAuthReply,
  refusal,
  type SessionBinding,
} from "./handshake.js";
export {
  type Auth,
  type CallError,
  type Challenge,
  type ClientFrame,
  callErrorSchema,
  clientFrameSchema,
  dataDirIdSchema,
  type Hello,
  type HostFrame,
  type HostHandshake,
  helloSchema,
  hostFrameSchema,
  hostHandshakeSchema,
  methodSchema,
  nonceSchema,
  profileSlugSchema,
  REFUSAL_MESSAGES,
  REFUSAL_REASONS,
  type RefusalReason,
  type Refused,
  ROLES,
  type Role,
  roleSchema,
} from "./messages.js";
export { roleAllows } from "./roles.js";
export {
  compatible,
  HOST_PROTOCOL,
  type ProtocolVersion,
  protocolVersionSchema,
} from "./version.js";
