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
//   SAS       both show 6 digits = H(T | nonceN); the owner compares and confirms on the inviter
//   welcome   inviter -> joiner   pairing wrap (sealForPairing), the joiner's certificate, the
//                                 registry events; signed by the inviter over T | nonceN | wrap hash
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
// (events.md 3.3).

import type { UnstampedEvent } from "../carrier.js";
import {
  BoxKeyPair,
  CryptoError,
  certifyDevice,
  type DeviceIdentity,
  isDeviceId,
  type Keyring,
  openPairingWrap,
  pairingWrapHash,
  type RecoveryPublicKeys,
  Secret,
  type Sodium,
  sealForPairing,
} from "../crypto/index.js";
import { DEFAULT_MAX_DRIFT_MS, isHlc } from "../hlc.js";
import {
  type CanonicalValue,
  canonicalJson,
  concat,
  equalBytes,
  fromHex,
  fromUtf8,
  isCanonicalValue,
  isHex,
  isRecord,
  lp,
  toHex,
  utf8,
} from "./bytes.js";
import { buildDeviceAdded, isDeviceName, isUlid, type LogEvent } from "./events.js";
import { foldRegistry, type Registry } from "./registry.js";
import { signStatement, verifyStatement } from "./statements.js";

const PAIRING_VERSION = 1;
const INVITE_PREFIX = "cashu-pair:";
export const DEFAULT_INVITE_TTL_MS = 5 * 60 * 1000;
const NONCE_BYTES = 32;
const SAS_MODULUS = 1_000_000;
const MAX_MESSAGE = 4 * 1024 * 1024;

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

function hash(sodium: Sodium, context: string, ...parts: Uint8Array[]): Uint8Array {
  return sodium.hash(32, concat(utf8(context), ...parts));
}

function sessionId(sodium: Sodium, ephemeral: Uint8Array): string {
  return toHex(sodium.hash(16, concat(utf8("cashu/pairing-session/v1"), ephemeral)));
}

interface JoinerKeys {
  readonly deviceId: string;
  readonly signPublicKey: Uint8Array;
  readonly boxPublicKey: Uint8Array;
}

function commitment(sodium: Sodium, session: string, joiner: JoinerKeys, nonce: Uint8Array) {
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

interface TranscriptInput {
  readonly invite: Invite;
  readonly joiner: JoinerKeys;
  readonly name: string;
  readonly joinerClock: number;
  readonly commit: Uint8Array;
  readonly inviterNonce: Uint8Array;
  readonly inviterClock: number;
  readonly recovery: RecoveryPublicKeys;
}

function transcript(sodium: Sodium, t: TranscriptInput): Uint8Array {
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

function welcomeBody(
  sodium: Sodium,
  transcriptHash: Uint8Array,
  joinerNonce: Uint8Array,
  wrapHash: Uint8Array,
  certificate: Uint8Array,
  registryJson: string,
): Uint8Array {
  return concat(
    lp(utf8("welcome")),
    transcriptHash,
    joinerNonce,
    wrapHash,
    hash(sodium, "cashu/pairing-cert/v1", certificate),
    hash(sodium, "cashu/pairing-registry/v1", utf8(registryJson)),
  );
}

type Message = Record<string, CanonicalValue>;

function seal(sodium: Sodium, message: Message, to: Uint8Array): Uint8Array {
  return sodium.seal(utf8(canonicalJson(message)), to);
}

function open(
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

function abortMessage(sodium: Sodium, session: string, reason: PairingFailure, to: Uint8Array) {
  return seal(sodium, { t: "abort", s: session, why: reason }, to);
}

function withinSkew(a: number, b: number, maxSkewMs: number): boolean {
  return Math.abs(a - b) <= maxSkewMs;
}

/** Registry events as the welcome carries them. */
function encodeRegistryEvents(events: readonly LogEvent[]): CanonicalValue[] {
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

function decodeRegistryEvents(value: unknown): LogEvent[] | undefined {
  if (!Array.isArray(value) || value.length > 4096) return undefined;
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

// ---------------------------------------------------------------------------------------------
// Inviter

export interface InviterOptions {
  readonly sodium: Sodium;
  readonly identity: DeviceIdentity;
  readonly ring: Keyring;
  readonly registry: Registry;
  /** Inviter clock, ms. */
  readonly now: number;
  readonly rendezvous?: string;
  readonly ttlMs?: number;
  readonly maxSkewMs?: number;
}

export interface InviterWelcome {
  /** The welcome message for the joiner. */
  readonly reply: Uint8Array;
  /** Write this to the log: the joiner's signed `device.added` (with its certificate). */
  readonly deviceAdded: UnstampedEvent;
  readonly certificate: Uint8Array;
  readonly device: { readonly deviceId: string; readonly name: string };
}

type InviterState =
  | { readonly kind: "invited" }
  | {
      readonly kind: "challenged";
      readonly joiner: JoinerKeys;
      readonly name: string;
      readonly commit: Uint8Array;
      readonly transcript: Uint8Array;
    }
  | {
      readonly kind: "sas";
      readonly joiner: JoinerKeys;
      readonly name: string;
      readonly transcript: Uint8Array;
      readonly joinerNonce: Uint8Array;
      readonly sas: string;
    }
  | { readonly kind: "done" };

export class PairingInviter {
  readonly invite: Invite;
  readonly session: string;
  readonly #o: InviterOptions;
  readonly #ephemeral: BoxKeyPair;
  #state: InviterState = { kind: "invited" };

  private constructor(o: InviterOptions, ephemeral: BoxKeyPair, invite: Invite) {
    this.#o = o;
    this.#ephemeral = ephemeral;
    this.invite = invite;
    this.session = sessionId(o.sodium, invite.ephemeralPublicKey);
  }

  /** Starts an invitation; show `qr` as a QR code. Fails when this device is not trusted. */
  static create(o: InviterOptions): PairingStep<{ inviter: PairingInviter; qr: string }> {
    if (!o.registry.isTrusted(o.identity.deviceId) || o.registry.vaultId !== o.ring.vaultId) {
      return { ok: false, reason: "not_trusted" };
    }
    const ephemeral = new BoxKeyPair(new Secret(o.sodium.randomBytes(32)));
    const invite: Invite = {
      vaultId: o.ring.vaultId,
      inviter: o.identity.deviceId,
      inviterSignPublicKey: o.identity.signPublicKey,
      ephemeralPublicKey: ephemeral.publicKey,
      expiresAt: o.now + (o.ttlMs ?? DEFAULT_INVITE_TTL_MS),
      rendezvous: o.rendezvous,
    };
    const inviter = new PairingInviter(o, ephemeral, invite);
    return { ok: true, value: { inviter, qr: encodeInvite(invite) } };
  }

  get state(): InviterState["kind"] {
    return this.#state.kind;
  }

  #fail(reason: PairingFailure, to?: Uint8Array): PairingFailed {
    this.#state = { kind: "done" };
    this.#ephemeral.wipe();
    return to
      ? { ok: false, reason, reply: abortMessage(this.#o.sodium, this.session, reason, to) }
      : { ok: false, reason };
  }

  /** hello -> challenge. `now` is the inviter clock. */
  receiveHello(sealed: Uint8Array, now: number): PairingStep<{ reply: Uint8Array }> {
    if (this.#state.kind !== "invited") return this.#fail("unexpected");
    const m = open(this.#o.sodium, sealed, this.#ephemeral);
    if (!m) return this.#fail("malformed");
    if (m.t === "abort") return this.#fail("aborted");
    const { t, s, d, sp, bp, n, c, k } = m;
    if (
      t !== "hello" ||
      typeof d !== "string" ||
      !isDeviceId(d) ||
      !isHex(sp, 32) ||
      !isHex(bp, 32) ||
      !isDeviceName(n) ||
      !Number.isSafeInteger(c) ||
      !isHex(k, 32)
    ) {
      return this.#fail("malformed");
    }
    const joiner: JoinerKeys = {
      deviceId: d,
      signPublicKey: fromHex(sp),
      boxPublicKey: fromHex(bp),
    };
    if (s !== this.session) return this.#fail("wrong_session", joiner.boxPublicKey);
    if (now > this.invite.expiresAt) return this.#fail("expired", joiner.boxPublicKey);
    const maxSkew = this.#o.maxSkewMs ?? DEFAULT_MAX_DRIFT_MS;
    if (!withinSkew(c as number, now, maxSkew))
      return this.#fail("clock_skew", joiner.boxPublicKey);
    if (this.#o.registry.isRegistered(d) || d === this.#o.identity.deviceId) {
      return this.#fail("already_registered", joiner.boxPublicKey);
    }
    const nonce = this.#o.sodium.randomBytes(NONCE_BYTES);
    const recovery = this.#o.ring.recovery;
    const commit = fromHex(k);
    const transcriptHash = transcript(this.#o.sodium, {
      invite: this.invite,
      joiner,
      name: n,
      joinerClock: c as number,
      commit,
      inviterNonce: nonce,
      inviterClock: now,
      recovery,
    });
    const sig = signStatement(
      this.#o.identity,
      "cashu/pairing/v1",
      concat(lp(utf8("challenge")), transcriptHash),
    );
    this.#state = { kind: "challenged", joiner, name: n, commit, transcript: transcriptHash };
    const reply = seal(
      this.#o.sodium,
      {
        t: "challenge",
        s: this.session,
        r: toHex(nonce),
        c: now,
        rb: toHex(recovery.boxPublicKey),
        rs: toHex(recovery.signPublicKey),
        g: toHex(sig),
      },
      joiner.boxPublicKey,
    );
    return { ok: true, value: { reply } };
  }

  /** reveal -> the SAS to show next to the joiner's. */
  receiveReveal(sealed: Uint8Array): PairingStep<{ sas: string }> {
    const state = this.#state;
    if (state.kind !== "challenged") return this.#fail("unexpected");
    const m = open(this.#o.sodium, sealed, this.#ephemeral);
    if (!m) return this.#fail("malformed", state.joiner.boxPublicKey);
    if (m.t === "abort") return this.#fail("aborted");
    if (m.t !== "reveal" || m.s !== this.session || !isHex(m.r, NONCE_BYTES)) {
      return this.#fail("malformed", state.joiner.boxPublicKey);
    }
    const nonce = fromHex(m.r);
    if (!equalBytes(commitment(this.#o.sodium, this.session, state.joiner, nonce), state.commit)) {
      return this.#fail("commit_mismatch", state.joiner.boxPublicKey);
    }
    const sas = shortAuthenticationString(this.#o.sodium, state.transcript, nonce);
    this.#state = { ...state, kind: "sas", joinerNonce: nonce, sas };
    return { ok: true, value: { sas } };
  }

  /** The owner rejected the SAS (or cancelled): nothing is sealed. Send `reply` to the joiner. */
  reject(): PairingFailed {
    const state = this.#state;
    const to =
      state.kind === "challenged" || state.kind === "sas" ? state.joiner.boxPublicKey : undefined;
    return this.#fail("sas_rejected", to);
  }

  /**
   * The owner confirmed that both screens show the same SAS: certify the joiner, seal the keyring
   * for its box key and sign the welcome. `eid` is for the `device.added` event.
   */
  confirm(eid: string): PairingStep<InviterWelcome> {
    const state = this.#state;
    if (state.kind !== "sas") return this.#fail("unexpected");
    const { sodium, identity, ring, registry } = this.#o;
    const subject = {
      deviceId: state.joiner.deviceId,
      signPublicKey: state.joiner.signPublicKey,
      boxPublicKey: state.joiner.boxPublicKey,
    };
    const certificate = certifyDevice(sodium, identity, subject, ring.vaultId);
    const wrap = sealForPairing(sodium, ring, state.joiner.boxPublicKey);
    const wrapHash = pairingWrapHash(sodium, wrap);
    const registryEvents = encodeRegistryEvents(registry.events);
    const registryJson = canonicalJson(registryEvents);
    const sig = signStatement(
      identity,
      "cashu/pairing/v1",
      welcomeBody(sodium, state.transcript, state.joinerNonce, wrapHash, certificate, registryJson),
    );
    const reply = seal(
      sodium,
      {
        t: "welcome",
        s: this.session,
        w: toHex(wrap),
        h: toHex(wrapHash),
        cert: toHex(certificate),
        reg: registryEvents,
        g: toHex(sig),
      },
      state.joiner.boxPublicKey,
    );
    const deviceAdded = buildDeviceAdded(
      identity,
      ring.vaultId,
      eid,
      subject,
      state.name,
      certificate,
    );
    this.#state = { kind: "done" };
    this.#ephemeral.wipe();
    return {
      ok: true,
      value: {
        reply,
        deviceAdded,
        certificate,
        device: { deviceId: subject.deviceId, name: state.name },
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Joiner

export interface JoinerOptions {
  readonly sodium: Sodium;
  readonly identity: DeviceIdentity;
  /** This device's display name (shown in the registry). */
  readonly name: string;
  readonly maxSkewMs?: number;
}

export interface JoinerWelcome {
  readonly ring: Keyring;
  /** The registry events from the inviter: seed this device's registry event set with them. */
  readonly registryEvents: readonly LogEvent[];
  /** This device's certificate: keep it as a bootstrap certificate until its `device.added` arrives. */
  readonly certificate: Uint8Array;
  readonly registry: Registry;
  readonly inviter: string;
}

type JoinerState =
  | {
      readonly kind: "hello";
      readonly nonce: Uint8Array;
      readonly clock: number;
      readonly commit: Uint8Array;
    }
  | {
      readonly kind: "sas";
      readonly transcript: Uint8Array;
      readonly nonce: Uint8Array;
      readonly recovery: RecoveryPublicKeys;
      readonly sas: string;
    }
  | { readonly kind: "done" };

export class PairingJoiner {
  readonly invite: Invite;
  readonly session: string;
  readonly #o: JoinerOptions;
  #state: JoinerState;

  private constructor(o: JoinerOptions, invite: Invite, state: JoinerState) {
    this.#o = o;
    this.invite = invite;
    this.session = sessionId(o.sodium, invite.ephemeralPublicKey);
    this.#state = state;
  }

  /** Scans the QR and builds the hello. `now` is the joiner clock. */
  static start(
    o: JoinerOptions,
    qr: string,
    now: number,
  ): PairingStep<{ joiner: PairingJoiner; hello: Uint8Array }> {
    const invite = decodeInvite(qr);
    if (!invite || !isDeviceName(o.name)) return { ok: false, reason: "malformed" };
    const maxSkew = o.maxSkewMs ?? DEFAULT_MAX_DRIFT_MS;
    if (now > invite.expiresAt + maxSkew) return { ok: false, reason: "expired" };
    if (invite.inviter === o.identity.deviceId) return { ok: false, reason: "already_registered" };
    const nonce = o.sodium.randomBytes(NONCE_BYTES);
    const keys = joinerKeys(o.identity);
    const session = sessionId(o.sodium, invite.ephemeralPublicKey);
    const commit = commitment(o.sodium, session, keys, nonce);
    const joiner = new PairingJoiner(o, invite, { kind: "hello", nonce, clock: now, commit });
    const hello = seal(
      o.sodium,
      {
        t: "hello",
        s: session,
        d: keys.deviceId,
        sp: toHex(keys.signPublicKey),
        bp: toHex(keys.boxPublicKey),
        n: o.name,
        c: now,
        k: toHex(commit),
      },
      invite.ephemeralPublicKey,
    );
    return { ok: true, value: { joiner, hello } };
  }

  get state(): JoinerState["kind"] {
    return this.#state.kind;
  }

  #fail(reason: PairingFailure, notify = true): PairingFailed {
    this.#state = { kind: "done" };
    return notify
      ? {
          ok: false,
          reason,
          reply: abortMessage(this.#o.sodium, this.session, reason, this.invite.ephemeralPublicKey),
        }
      : { ok: false, reason };
  }

  /** challenge -> reveal, and the SAS to show. `now` is the joiner clock. */
  receiveChallenge(
    sealed: Uint8Array,
    now: number,
  ): PairingStep<{ reply: Uint8Array; sas: string }> {
    const state = this.#state;
    if (state.kind !== "hello") return this.#fail("unexpected");
    const m = open(this.#o.sodium, sealed, this.#o.identity.box);
    if (!m) return this.#fail("malformed");
    if (m.t === "abort") return this.#fail("aborted", false);
    const { t, s, r, c, rb, rs, g } = m;
    if (
      t !== "challenge" ||
      s !== this.session ||
      !isHex(r, NONCE_BYTES) ||
      !Number.isSafeInteger(c) ||
      !isHex(rb, 32) ||
      !isHex(rs, 32) ||
      !isHex(g, 64)
    ) {
      return this.#fail("malformed");
    }
    const recovery: RecoveryPublicKeys = { boxPublicKey: fromHex(rb), signPublicKey: fromHex(rs) };
    const transcriptHash = transcript(this.#o.sodium, {
      invite: this.invite,
      joiner: joinerKeys(this.#o.identity),
      name: this.#o.name,
      joinerClock: state.clock,
      commit: state.commit,
      inviterNonce: fromHex(r),
      inviterClock: c as number,
      recovery,
    });
    const signed = concat(lp(utf8("challenge")), transcriptHash);
    if (
      !verifyStatement("cashu/pairing/v1", signed, fromHex(g), this.invite.inviterSignPublicKey)
    ) {
      return this.#fail("bad_signature");
    }
    if (!withinSkew(c as number, now, this.#o.maxSkewMs ?? DEFAULT_MAX_DRIFT_MS)) {
      return this.#fail("clock_skew");
    }
    const sas = shortAuthenticationString(this.#o.sodium, transcriptHash, state.nonce);
    this.#state = { kind: "sas", transcript: transcriptHash, nonce: state.nonce, recovery, sas };
    const reply = seal(
      this.#o.sodium,
      { t: "reveal", s: this.session, r: toHex(state.nonce) },
      this.invite.ephemeralPublicKey,
    );
    return { ok: true, value: { reply, sas } };
  }

  /** welcome -> the vault's ring and registry on this device. */
  receiveWelcome(sealed: Uint8Array): PairingStep<JoinerWelcome> {
    const state = this.#state;
    if (state.kind !== "sas") return this.#fail("unexpected");
    const { sodium, identity } = this.#o;
    const m = open(sodium, sealed, identity.box);
    if (!m) return this.#fail("malformed");
    if (m.t === "abort") return this.#fail("aborted", false);
    const { t, s, w, h, cert, reg, g } = m;
    const events = decodeRegistryEvents(reg);
    if (
      t !== "welcome" ||
      s !== this.session ||
      !isHex(w) ||
      !isHex(h, 32) ||
      !isHex(cert) ||
      !isHex(g, 64) ||
      !events ||
      !isCanonicalValue(reg)
    ) {
      return this.#fail("malformed");
    }
    const certificate = fromHex(cert);
    const wrapHash = fromHex(h);
    const body = welcomeBody(
      sodium,
      state.transcript,
      state.nonce,
      wrapHash,
      certificate,
      canonicalJson(reg),
    );
    if (!verifyStatement("cashu/pairing/v1", body, fromHex(g), this.invite.inviterSignPublicKey)) {
      return this.#fail("bad_signature");
    }
    let ring: Keyring;
    try {
      ring = openPairingWrap(sodium, fromHex(w), identity, this.invite.vaultId, wrapHash);
    } catch (e) {
      if (!(e instanceof CryptoError)) throw e;
      return this.#fail("wrap_rejected");
    }
    const recovery = ring.recovery;
    if (
      !equalBytes(recovery.boxPublicKey, state.recovery.boxPublicKey) ||
      !equalBytes(recovery.signPublicKey, state.recovery.signPublicKey)
    ) {
      ring.wipe();
      return this.#fail("recovery_mismatch");
    }
    const registry = foldRegistry(sodium, { vaultId: ring.vaultId, recovery }, events, {
      bootstrapCertificates: [certificate],
    });
    const me = registry.trusted.get(identity.deviceId);
    const inviter = registry.trusted.get(this.invite.inviter);
    if (
      !me ||
      !equalBytes(me.signPublicKey, identity.signPublicKey) ||
      !equalBytes(me.boxPublicKey, identity.box.publicKey) ||
      !inviter ||
      !equalBytes(inviter.signPublicKey, this.invite.inviterSignPublicKey)
    ) {
      ring.wipe();
      return this.#fail("not_trusted");
    }
    this.#state = { kind: "done" };
    return {
      ok: true,
      value: { ring, registryEvents: events, certificate, registry, inviter: this.invite.inviter },
    };
  }
}

function joinerKeys(identity: DeviceIdentity): JoinerKeys {
  return {
    deviceId: identity.deviceId,
    signPublicKey: identity.signPublicKey,
    boxPublicKey: identity.box.publicKey,
  };
}
