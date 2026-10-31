import {
  type CertificateCache,
  CryptoError,
  type DeviceIdentity,
  type Keyring,
  openPairingWrap,
  type RecoveryPublicKeys,
  type Sodium,
} from "../crypto/index.js";
import { DEFAULT_MAX_DRIFT_MS } from "../hlc.js";
import {
  type CanonicalValue,
  concat,
  equalBytes,
  fromHex,
  isCanonicalValue,
  isHex,
  lp,
  toHex,
  utf8,
} from "./bytes.js";
import { isDeviceName, type LogEvent } from "./events.js";
import {
  abortMessage,
  commitment,
  decodeInvite,
  decodeRegistryEvents,
  hash,
  type Invite,
  joinerKeys,
  MAX_REGISTRY_EVENTS,
  NONCE_BYTES,
  open,
  PAGE_SIZE,
  type PairingFailed,
  type PairingFailure,
  type PairingStep,
  registryHash,
  seal,
  sessionId,
  shortAuthenticationString,
  transcript,
  welcomeBody,
  withinSkew,
} from "./pairingProtocol.js";
import { recoveryHistory } from "./recoveryChange.js";
import { foldRegistry, type Registry } from "./registry.js";
import { type StatementVerifier, verifyStatement } from "./statements.js";

// ---------------------------------------------------------------------------------------------
// Joiner

export interface JoinerOptions {
  readonly sodium: Sodium;
  readonly identity: DeviceIdentity;
  /** This device's display name (shown in the registry). */
  readonly name: string;
  readonly maxSkewMs?: number;
  /**
   * Signature and certificate checks of the welcome's registry fold: pass the ones this device's
   * `VaultDevices` will use, so the registry it seeds is not verified a second time.
   */
  readonly verify?: StatementVerifier;
  readonly certificateCache?: CertificateCache;
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
  | {
      readonly kind: "pages";
      readonly ring: Keyring;
      readonly certificate: Uint8Array;
      readonly recovery: RecoveryPublicKeys;
      readonly expected: { readonly count: number; readonly hash: Uint8Array };
      readonly collected: CanonicalValue[];
    }
  | { readonly kind: "done" };

/** The joiner's progress after the welcome: done, or more registry pages to receive. */
export type JoinerProgress =
  | { readonly done: true; readonly welcome: JoinerWelcome }
  | { readonly done: false };

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

  /** welcome -> the vault's ring, and the registry once every page arrived. */
  receiveWelcome(sealed: Uint8Array): PairingStep<JoinerProgress> {
    const state = this.#state;
    if (state.kind !== "sas") return this.#fail("unexpected");
    const { sodium, identity } = this.#o;
    const m = open(sodium, sealed, identity.box);
    if (!m) return this.#fail("malformed");
    if (m.t === "abort") return this.#fail("aborted", false);
    const { t, s, w, h, cert, n, rh, reg, g } = m;
    if (
      t !== "welcome" ||
      s !== this.session ||
      !isHex(w) ||
      !isHex(h, 32) ||
      !isHex(cert) ||
      !isHex(g, 64) ||
      !Number.isSafeInteger(n) ||
      (n as number) < 0 ||
      (n as number) > MAX_REGISTRY_EVENTS ||
      !isHex(rh, 32) ||
      !Array.isArray(reg) ||
      !isCanonicalValue(reg) ||
      reg.length !== Math.min(n as number, PAGE_SIZE)
    ) {
      return this.#fail("malformed");
    }
    const certificate = fromHex(cert);
    const wrapHash = fromHex(h);
    const expected = { count: n as number, hash: fromHex(rh) };
    const body = welcomeBody(
      state.transcript,
      state.nonce,
      wrapHash,
      hash(sodium, "cashu/pairing-cert/v1", certificate),
      expected,
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
    this.#state = {
      kind: "pages",
      ring,
      certificate,
      recovery,
      expected,
      collected: [...(reg as CanonicalValue[])],
    };
    return this.#finishIfComplete();
  }

  /** One more page of registry events (sent after the welcome, in order). */
  receivePage(sealed: Uint8Array): PairingStep<JoinerProgress> {
    const state = this.#state;
    if (state.kind !== "pages") return this.#fail("unexpected");
    const m = open(this.#o.sodium, sealed, this.#o.identity.box);
    if (!m) return this.#wipeAndFail(state.ring, "malformed");
    if (m.t === "abort") return this.#wipeAndFail(state.ring, "aborted", false);
    const index = Math.ceil(state.collected.length / PAGE_SIZE);
    const remaining = state.expected.count - state.collected.length;
    if (
      m.t !== "regpage" ||
      m.s !== this.session ||
      m.i !== index ||
      !Array.isArray(m.reg) ||
      !isCanonicalValue(m.reg) ||
      m.reg.length !== Math.min(remaining, PAGE_SIZE)
    ) {
      return this.#wipeAndFail(state.ring, "malformed");
    }
    state.collected.push(...(m.reg as CanonicalValue[]));
    return this.#finishIfComplete();
  }

  #wipeAndFail(ring: Keyring, reason: PairingFailure, notify = true): PairingFailed {
    ring.wipe();
    return this.#fail(reason, notify);
  }

  #finishIfComplete(): PairingStep<JoinerProgress> {
    const state = this.#state;
    if (state.kind !== "pages") return this.#fail("unexpected");
    if (state.collected.length < state.expected.count) return { ok: true, value: { done: false } };
    const { sodium, identity } = this.#o;
    if (!equalBytes(registryHash(sodium, state.collected), state.expected.hash)) {
      return this.#wipeAndFail(state.ring, "bad_signature");
    }
    const events: LogEvent[] = [];
    for (let at = 0; at < state.collected.length; at += PAGE_SIZE) {
      const page = decodeRegistryEvents(state.collected.slice(at, at + PAGE_SIZE));
      if (!page) return this.#wipeAndFail(state.ring, "malformed");
      events.push(...page);
    }
    const { ring, certificate, recovery } = state;
    // The inviter may have applied recovery-key changes (n1): the chain from earlier keys to the
    // pinned one re-roots the registry exactly as on the inviter.
    const history = recoveryHistory(ring.vaultId, recovery, events);
    const registry = foldRegistry(
      sodium,
      { vaultId: ring.vaultId, recovery, previous: history.previous },
      events,
      {
        bootstrapCertificates: [certificate, ...history.certificates],
        ...(this.#o.verify ? { verify: this.#o.verify } : {}),
        ...(this.#o.certificateCache ? { certificateCache: this.#o.certificateCache } : {}),
      },
    );
    const me = registry.trusted.get(identity.deviceId);
    const inviter = registry.trusted.get(this.invite.inviter);
    if (
      !me ||
      !equalBytes(me.signPublicKey, identity.signPublicKey) ||
      !equalBytes(me.boxPublicKey, identity.box.publicKey) ||
      !inviter ||
      !equalBytes(inviter.signPublicKey, this.invite.inviterSignPublicKey)
    ) {
      return this.#wipeAndFail(ring, "not_trusted");
    }
    this.#state = { kind: "done" };
    return {
      ok: true,
      value: {
        done: true,
        welcome: {
          ring,
          registryEvents: events,
          certificate,
          registry,
          inviter: this.invite.inviter,
        },
      },
    };
  }
}
