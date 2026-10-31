import {
  type BoxKeyPair,
  CryptoError,
  type DeviceIdentity,
  isDeviceId,
  type RecoveryPublicKeys,
  type Sodium,
} from "../crypto/index.js";
import { isHlc } from "../hlc.js";
import {
  type CanonicalValue,
  canonicalJson,
  concat,
  fromHex,
  fromUtf8,
  isCanonicalValue,
  isHex,
  isRecord,
  lp,
  toHex,
  utf8,
} from "./bytes.js";
import { isUlid, type LogEvent } from "./events.js";

const PAIRING_VERSION = 1;
const INVITE_PREFIX = "cashu-pair:";
export const DEFAULT_INVITE_TTL_MS = 5 * 60 * 1000;
export const NONCE_BYTES = 32;
const SAS_MODULUS = 1_000_000;
const MAX_MESSAGE = 4 * 1024 * 1024;
/** How long the owner has to type the phone's code after the SAS step began. */
export const SAS_TTL_MS = 2 * 60 * 1000;
/** Typing attempts before the session ends (a man in the middle never gets to type). */
export const SAS_ATTEMPTS = 3;
/** Registry events per welcome / page message. */
export const PAGE_SIZE = 512;
/** Most registry events a welcome may announce (the registry caps keep real logs far below). */
export const MAX_REGISTRY_EVENTS = 65_536;

export type PairingFailure =
  | "malformed"
  | "wrong_session"
  | "unexpected"
  | "expired"
  | "clock_skew"
  | "already_registered"
  | "commit_mismatch"
  | "bad_signature"
  | "sas_rejected"
  | "sas_mismatch"
  | "capacity"
  | "aborted"
  | "not_trusted"
  | "wrap_rejected"
  | "recovery_mismatch";

/** `reply` (an abort message) may be sent to the peer; the session is dead either way. */
export interface PairingFailed {
  readonly ok: false;
  readonly reason: PairingFailure;
  readonly reply?: Uint8Array;
}

export type PairingStep<T> = { readonly ok: true; readonly value: T } | PairingFailed;

export interface Invite {
  readonly vaultId: string;
  readonly inviter: string;
  readonly inviterSignPublicKey: Uint8Array;
  readonly ephemeralPublicKey: Uint8Array;
  /** Inviter clock, ms. */
  readonly expiresAt: number;
  /** Opaque rendezvous hint for the pairing link (relay channel, local address); not trusted. */
  readonly rendezvous: string | undefined;
}

export function encodeInvite(invite: Invite): string {
  const body: Record<string, CanonicalValue> = {
    v: PAIRING_VERSION,
    vault: invite.vaultId,
    inviter: invite.inviter,
    sign: toHex(invite.inviterSignPublicKey),
    eph: toHex(invite.ephemeralPublicKey),
    exp: invite.expiresAt,
  };
  if (invite.rendezvous !== undefined) body.rv = invite.rendezvous;
  return INVITE_PREFIX + canonicalJson(body);
}

export function decodeInvite(text: string): Invite | undefined {
  if (!text.startsWith(INVITE_PREFIX) || text.length > 2048) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text.slice(INVITE_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!isRecord(body) || body.v !== PAIRING_VERSION) return undefined;
  const { vault, inviter, sign, eph, exp, rv } = body;
  if (
    !isHex(vault, 16) ||
    typeof inviter !== "string" ||
    !isDeviceId(inviter) ||
    !isHex(sign, 32) ||
    !isHex(eph, 32) ||
    !Number.isSafeInteger(exp) ||
    !(rv === undefined || (typeof rv === "string" && rv.length <= 512))
  ) {
    return undefined;
  }
  return {
    vaultId: vault,
    inviter,
    inviterSignPublicKey: fromHex(sign),
    ephemeralPublicKey: fromHex(eph),
    expiresAt: exp as number,
    rendezvous: rv,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared protocol pieces

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

export function hash(sodium: Sodium, context: string, ...parts: Uint8Array[]): Uint8Array {
  return sodium.hash(32, concat(utf8(context), ...parts));
}

export function sessionId(sodium: Sodium, ephemeral: Uint8Array): string {
  return toHex(sodium.hash(16, concat(utf8("cashu/pairing-session/v1"), ephemeral)));
}

export interface JoinerKeys {
  readonly deviceId: string;
  readonly signPublicKey: Uint8Array;
  readonly boxPublicKey: Uint8Array;
}

export function commitment(sodium: Sodium, session: string, joiner: JoinerKeys, nonce: Uint8Array) {
  return hash(
    sodium,
    "cashu/pairing-commit/v1",
    lp(utf8(session)),
    fromHex(joiner.deviceId),
    joiner.signPublicKey,
    joiner.boxPublicKey,
    nonce,
  );
}

export interface TranscriptInput {
  readonly invite: Invite;
  readonly joiner: JoinerKeys;
  readonly name: string;
  readonly joinerClock: number;
  readonly commit: Uint8Array;
  readonly inviterNonce: Uint8Array;
  readonly inviterClock: number;
  readonly recovery: RecoveryPublicKeys;
}

export function transcript(sodium: Sodium, t: TranscriptInput): Uint8Array {
  return hash(
    sodium,
    "cashu/pairing-transcript/v1",
    lp(utf8(t.invite.vaultId)),
    fromHex(t.invite.inviter),
    t.invite.inviterSignPublicKey,
    t.invite.ephemeralPublicKey,
    u64(t.invite.expiresAt),
    fromHex(t.joiner.deviceId),
    t.joiner.signPublicKey,
    t.joiner.boxPublicKey,
    lp(utf8(t.name)),
    u64(t.joinerClock),
    t.commit,
    t.inviterNonce,
    u64(t.inviterClock),
    t.recovery.boxPublicKey,
    t.recovery.signPublicKey,
  );
}

/** The 6 digits both screens show. */
export function shortAuthenticationString(
  sodium: Sodium,
  transcriptHash: Uint8Array,
  joinerNonce: Uint8Array,
): string {
  const h = hash(sodium, "cashu/pairing-sas/v1", transcriptHash, joinerNonce);
  const n = new DataView(h.buffer, h.byteOffset, 4).getUint32(0) % SAS_MODULUS;
  return n.toString().padStart(6, "0");
}

export function registryHash(sodium: Sodium, events: readonly CanonicalValue[]): Uint8Array {
  return hash(sodium, "cashu/pairing-registry/v2", utf8(canonicalJson([...events])));
}

export function welcomeBody(
  transcriptHash: Uint8Array,
  joinerNonce: Uint8Array,
  wrapHash: Uint8Array,
  certificateHash: Uint8Array,
  registry: { count: number; hash: Uint8Array },
): Uint8Array {
  return concat(
    lp(utf8("welcome/v2")),
    transcriptHash,
    joinerNonce,
    wrapHash,
    certificateHash,
    u64(registry.count),
    registry.hash,
  );
}

export type Message = Record<string, CanonicalValue>;

export function seal(sodium: Sodium, message: Message, to: Uint8Array): Uint8Array {
  return sodium.seal(utf8(canonicalJson(message)), to);
}

export function open(
  sodium: Sodium,
  sealed: Uint8Array,
  keys: BoxKeyPair,
): Record<string, unknown> | undefined {
  if (sealed.length > MAX_MESSAGE) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      fromUtf8(sodium.sealOpen(sealed, keys.publicKey, keys.secretKey.expose())),
    );
    return isRecord(parsed) ? parsed : undefined;
  } catch (e) {
    if (e instanceof CryptoError && e.code !== "auth_failed") throw e;
    return undefined;
  }
}

export function abortMessage(
  sodium: Sodium,
  session: string,
  reason: PairingFailure,
  to: Uint8Array,
) {
  return seal(sodium, { t: "abort", s: session, why: reason }, to);
}

export function withinSkew(a: number, b: number, maxSkewMs: number): boolean {
  return Math.abs(a - b) <= maxSkewMs;
}

/** Registry events as the welcome carries them. */
export function encodeRegistryEvents(events: readonly LogEvent[]): CanonicalValue[] {
  return events.map((e) => {
    if (!isCanonicalValue(e.data)) throw new RangeError("registry event data is not canonical");
    return {
      i: e.eid,
      h: e.hlc,
      w: e.writer,
      p: [e.position.seg, e.position.offset],
      t: e.type,
      v: e.v,
      d: e.data,
    };
  });
}

export function decodeRegistryEvents(value: unknown): LogEvent[] | undefined {
  if (!Array.isArray(value) || value.length > PAGE_SIZE) return undefined;
  const out: LogEvent[] = [];
  for (const e of value) {
    if (!isRecord(e)) return undefined;
    const { i, h, w, p, t, v, d } = e;
    if (
      !isUlid(i) ||
      !isHlc(h) ||
      typeof w !== "string" ||
      !isDeviceId(w) ||
      !Array.isArray(p) ||
      p.length !== 2 ||
      !Number.isSafeInteger(p[0]) ||
      (p[0] as number) < 1 ||
      !Number.isSafeInteger(p[1]) ||
      (p[1] as number) < 0 ||
      typeof t !== "string" ||
      !Number.isSafeInteger(v) ||
      !isRecord(d)
    ) {
      return undefined;
    }
    out.push({
      eid: i,
      hlc: h,
      writer: w,
      position: { seg: p[0] as number, offset: p[1] as number },
      type: t,
      v: v as number,
      data: d,
    });
  }
  return out;
}

export function joinerKeys(identity: DeviceIdentity): JoinerKeys {
  return {
    deviceId: identity.deviceId,
    signPublicKey: identity.signPublicKey,
    boxPublicKey: identity.box.publicKey,
  };
}
