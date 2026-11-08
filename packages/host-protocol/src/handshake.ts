// The mutual handshake. The token (32 random bytes, a 0600 file next to the socket, new at every host
// start) never crosses the socket; each side proves it holds it with an HMAC over both nonces:
//
//   client hello {protocol, role, dataDir, profile?, build, nc}
//   host   challenge {ns, proof = HMAC(token, S | nc | ns | dataDir), protocol, build, features}
//   client verifies the host FIRST (a squatter on the socket learns nothing), then
//          auth {proof = HMAC(token, C | ns | nc | dataDir | role | profile)}
//   host   ready
//
// Both proofs bind the data dir id, the client proof also the role and profile, so a transcript
// cannot be replayed for another data dir or role. Refusals carry a fixed reason (messages.ts).
// Pure functions: nonces come in as parameters (the transport draws them from the OS CSPRNG).
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  type Auth,
  authSchema,
  type Challenge,
  type Hello,
  helloHeadSchema,
  helloSchema,
  hostHandshakeSchema,
  REFUSAL_MESSAGES,
  type RefusalReason,
  type Refused,
  type Role,
  tokenSchema,
} from "./messages.js";
import { compatible, type ProtocolVersion } from "./version.js";

const LABEL = "cashu-host/1";
const PACKAGED_BUILD = /^desktop-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[a-f0-9]{64}$/;
const packagedBuildMismatch = (role: Role, clientBuild: string, hostBuild: string) =>
  role !== "admin" &&
  (PACKAGED_BUILD.test(clientBuild) || PACKAGED_BUILD.test(hostBuild)) &&
  clientBuild !== hostBuild;

/** The token bytes from its file text (hex); undefined when the text is not a token. */
export function parseToken(text: string): Uint8Array | undefined {
  const parsed = tokenSchema.safeParse(text.trim());
  return parsed.success ? hexToBytes(parsed.data) : undefined;
}

/** The token's file text. */
export function formatToken(token: Uint8Array): string {
  if (token.length !== 32) throw new RangeError("a host token is 32 bytes");
  return bytesToHex(token);
}

/** A nonce's wire form (32 random bytes, hex). */
export function formatNonce(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new RangeError("a nonce is 32 bytes");
  return bytesToHex(bytes);
}

const mac = (token: Uint8Array, text: string) => bytesToHex(hmac(sha256, token, utf8ToBytes(text)));

export interface HostProofInput {
  readonly nc: string;
  readonly ns: string;
  readonly dataDir: string;
}

export interface ClientProofInput extends HostProofInput {
  readonly role: Role;
  readonly profile: string | undefined;
}

export const hostProof = (token: Uint8Array, p: HostProofInput) =>
  mac(token, `${LABEL}|S|${p.nc}|${p.ns}|${p.dataDir}`);

export const clientProof = (token: Uint8Array, p: ClientProofInput) =>
  mac(token, `${LABEL}|C|${p.ns}|${p.nc}|${p.dataDir}|${p.role}|${p.profile ?? ""}`);

/** Compares two proofs in time independent of where they differ. */
export function proofsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const refusal = (reason: RefusalReason): Refused => ({
  t: "refused",
  reason,
  message: REFUSAL_MESSAGES[reason],
});

// ---------------------------------------------------------------------------------------------
// Host side

export interface HostIdentity {
  readonly token: Uint8Array;
  readonly dataDir: string;
  readonly protocol: ProtocolVersion;
  readonly build: string;
  readonly features: readonly string[];
  /** True while the host shuts down: new clients are told to retry (and start a new host). */
  readonly stopping: boolean;
  /**
   * True while the host opens its stores (a host that opts into a starting phase): clients are told
   * to wait for this host, not to start another one. Absent means ready.
   */
  readonly starting?: boolean;
}

/** What the host remembers between its challenge and the client's auth. */
export interface PendingAuth {
  readonly hello: Hello;
  readonly ns: string;
}

export type HelloOutcome =
  | { readonly ok: true; readonly reply: Challenge; readonly pending: PendingAuth }
  | { readonly ok: false; readonly reply: Refused };

/** The host's answer to the first message of a connection. `ns` is a fresh nonce. */
export function answerHello(raw: unknown, host: HostIdentity, ns: string): HelloOutcome {
  const head = helloHeadSchema.safeParse(raw);
  if (!head.success) return { ok: false, reply: refusal("invalid") };
  // Another major is refused before its body is read: its shape may differ in any way.
  if (!compatible(head.data.protocol, host.protocol))
    return { ok: false, reply: refusal("protocol") };
  const parsed = helloSchema.safeParse(raw);
  if (!parsed.success) {
    const roleIssue = parsed.error.issues.some((i) => i.path[0] === "profile");
    return { ok: false, reply: refusal(roleIssue ? "role" : "invalid") };
  }
  const hello = parsed.data;
  if (hello.dataDir !== host.dataDir) return { ok: false, reply: refusal("data-dir") };
  if (packagedBuildMismatch(hello.role, hello.build, host.build))
    return { ok: false, reply: refusal("build") };
  if (host.stopping) return { ok: false, reply: refusal("stopping") };
  if (host.starting === true) return { ok: false, reply: refusal("starting") };
  return {
    ok: true,
    pending: { hello, ns },
    reply: {
      t: "challenge",
      ns,
      proof: hostProof(host.token, { nc: hello.nc, ns, dataDir: host.dataDir }),
      protocol: host.protocol,
      build: host.build,
      features: [...host.features],
    },
  };
}

/** The authenticated session's binding. */
export interface SessionBinding {
  readonly role: Role;
  readonly profile: string | undefined;
  readonly build: string;
  readonly protocol: ProtocolVersion;
}

export type AuthOutcome =
  | { readonly ok: true; readonly session: SessionBinding }
  | { readonly ok: false; readonly reply: Refused };

/** Checks the client's proof against the pending challenge. */
export function checkAuth(raw: unknown, pending: PendingAuth, token: Uint8Array): AuthOutcome {
  const parsed = authSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reply: refusal("invalid") };
  const { hello, ns } = pending;
  const expected = clientProof(token, {
    nc: hello.nc,
    ns,
    dataDir: hello.dataDir,
    role: hello.role,
    profile: hello.profile,
  });
  if (!proofsEqual(parsed.data.proof, expected)) return { ok: false, reply: refusal("auth") };
  return {
    ok: true,
    session: {
      role: hello.role,
      profile: hello.profile,
      build: hello.build,
      protocol: hello.protocol,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Client side

export interface HelloInput {
  readonly role: Role;
  readonly profile?: string;
  readonly dataDir: string;
  readonly build: string;
  readonly nc: string;
  readonly protocol: ProtocolVersion;
}

export function makeHello(input: HelloInput): Hello {
  return helloSchema.parse({
    t: "hello",
    protocol: input.protocol,
    role: input.role,
    dataDir: input.dataDir,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    build: input.build,
    nc: input.nc,
  });
}

/** What the client learns about the host from a verified challenge. */
export interface HostInfo {
  readonly protocol: ProtocolVersion;
  readonly build: string;
  readonly features: readonly string[];
}

export type ChallengeOutcome =
  | { readonly kind: "auth"; readonly reply: Auth; readonly host: HostInfo }
  | { readonly kind: "refused"; readonly reason: RefusalReason }
  /** The peer could not prove it holds the token: a stale token file or a squatter. */
  | { readonly kind: "unverified" }
  | { readonly kind: "invalid" };

/** The client's step after its hello: verify the host, then prove itself. */
export function answerChallenge(raw: unknown, hello: Hello, token: Uint8Array): ChallengeOutcome {
  const parsed = hostHandshakeSchema.safeParse(raw);
  if (!parsed.success) return { kind: "invalid" };
  const msg = parsed.data;
  if (msg.t === "refused") return { kind: "refused", reason: msg.reason };
  if (msg.t !== "challenge") return { kind: "invalid" };
  const expected = hostProof(token, { nc: hello.nc, ns: msg.ns, dataDir: hello.dataDir });
  if (!proofsEqual(msg.proof, expected)) return { kind: "unverified" };
  if (!compatible(msg.protocol, hello.protocol)) return { kind: "refused", reason: "protocol" };
  if (packagedBuildMismatch(hello.role, hello.build, msg.build))
    return { kind: "refused", reason: "build" };
  return {
    kind: "auth",
    host: { protocol: msg.protocol, build: msg.build, features: msg.features },
    reply: {
      t: "auth",
      proof: clientProof(token, {
        nc: hello.nc,
        ns: msg.ns,
        dataDir: hello.dataDir,
        role: hello.role,
        profile: hello.profile,
      }),
    },
  };
}

export type AuthReplyOutcome =
  | { readonly kind: "ready" }
  | { readonly kind: "refused"; readonly reason: RefusalReason }
  | { readonly kind: "invalid" };

/** The host's answer to the client's auth. */
export function readAuthReply(raw: unknown): AuthReplyOutcome {
  const parsed = hostHandshakeSchema.safeParse(raw);
  if (!parsed.success) return { kind: "invalid" };
  if (parsed.data.t === "ready") return { kind: "ready" };
  if (parsed.data.t === "refused") return { kind: "refused", reason: parsed.data.reason };
  return { kind: "invalid" };
}
