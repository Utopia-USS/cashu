// The inviter side of QR pairing (pairing.ts explains the protocol).

import type { UnstampedEvent } from "../carrier.js";
import {
  BoxKeyPair,
  certifyDevice,
  type DeviceIdentity,
  isDeviceId,
  type Keyring,
  pairingWrapHash,
  Secret,
  type Sodium,
  sealForPairing,
} from "../crypto/index.js";
import { DEFAULT_MAX_DRIFT_MS } from "../hlc.js";
import { concat, equalBytes, fromHex, isHex, lp, toHex, utf8 } from "./bytes.js";
import { buildDeviceAdded, isDeviceName } from "./events.js";
import {
  abortMessage,
  commitment,
  DEFAULT_INVITE_TTL_MS,
  encodeInvite,
  encodeRegistryEvents,
  hash,
  type Invite,
  type JoinerKeys,
  MAX_REGISTRY_EVENTS,
  NONCE_BYTES,
  open,
  PAGE_SIZE,
  type PairingFailed,
  type PairingFailure,
  type PairingStep,
  registryHash,
  SAS_ATTEMPTS,
  SAS_TTL_MS,
  seal,
  sessionId,
  shortAuthenticationString,
  transcript,
  welcomeBody,
  withinSkew,
} from "./pairingProtocol.js";
import { MAX_CERTS_PER_ISSUER, type Registry } from "./registry.js";
import { signStatement } from "./statements.js";

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
  /** Send these after `reply`, in order: the rest of the registry events. */
  readonly pages: readonly Uint8Array[];
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
      readonly expiresAt: number;
      readonly attemptsLeft: number;
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
    if (o.registry.certificatesIssuedBy(o.identity.deviceId) >= MAX_CERTS_PER_ISSUER) {
      return { ok: false, reason: "capacity" };
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

  /**
   * reveal -> ask the owner to type the 6 digits the joiner shows (`confirm`). The inviter never
   * shows its own SAS. `now` is the inviter clock.
   */
  receiveReveal(sealed: Uint8Array, now: number): PairingStep<{ awaitingCode: true }> {
    const state = this.#state;
    if (state.kind !== "challenged") return this.#fail("unexpected");
    if (now > this.invite.expiresAt + SAS_TTL_MS) {
      return this.#fail("expired", state.joiner.boxPublicKey);
    }
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
    this.#state = {
      kind: "sas",
      joiner: state.joiner,
      name: state.name,
      transcript: state.transcript,
      joinerNonce: nonce,
      sas,
      expiresAt: now + SAS_TTL_MS,
      attemptsLeft: SAS_ATTEMPTS,
    };
    return { ok: true, value: { awaitingCode: true } };
  }

  /** The owner rejected the SAS (or cancelled): nothing is sealed. Send `reply` to the joiner. */
  reject(): PairingFailed {
    const state = this.#state;
    const to =
      state.kind === "challenged" || state.kind === "sas" ? state.joiner.boxPublicKey : undefined;
    return this.#fail("sas_rejected", to);
  }

  /**
   * The owner typed the code the joiner shows. Only when it equals this inviter's SAS: certify the
   * joiner, seal the keyring for its box key and sign the welcome. A wrong code costs one of
   * SAS_ATTEMPTS (`attemptsLeft` in the failure keeps the session alive); after the last one, or
   * after SAS_TTL_MS, the session ends. `eid` is for the `device.added` event.
   */
  confirm(
    code: string,
    eid: string,
    now: number,
  ): PairingStep<InviterWelcome> | (PairingFailed & { readonly attemptsLeft: number }) {
    const state = this.#state;
    if (state.kind !== "sas") return this.#fail("unexpected");
    if (now > state.expiresAt) return this.#fail("expired", state.joiner.boxPublicKey);
    const typed = utf8(code.trim());
    if (!equalBytes(typed, utf8(state.sas))) {
      const attemptsLeft = state.attemptsLeft - 1;
      if (attemptsLeft <= 0) return this.#fail("sas_mismatch", state.joiner.boxPublicKey);
      this.#state = { ...state, attemptsLeft };
      return { ok: false, reason: "sas_mismatch", attemptsLeft };
    }
    const { sodium, identity, ring, registry } = this.#o;
    const subject = {
      deviceId: state.joiner.deviceId,
      signPublicKey: state.joiner.signPublicKey,
      boxPublicKey: state.joiner.boxPublicKey,
    };
    const certificate = certifyDevice(sodium, identity, subject, ring.vaultId);
    const wrap = sealForPairing(sodium, ring, state.joiner.boxPublicKey);
    const wrapHash = pairingWrapHash(sodium, wrap);
    const registryEvents = encodeRegistryEvents(registry.events.slice(0, MAX_REGISTRY_EVENTS));
    const regHash = registryHash(sodium, registryEvents);
    const sig = signStatement(
      identity,
      "cashu/pairing/v1",
      welcomeBody(
        state.transcript,
        state.joinerNonce,
        wrapHash,
        hash(sodium, "cashu/pairing-cert/v1", certificate),
        { count: registryEvents.length, hash: regHash },
      ),
    );
    const reply = seal(
      sodium,
      {
        t: "welcome",
        s: this.session,
        w: toHex(wrap),
        h: toHex(wrapHash),
        cert: toHex(certificate),
        n: registryEvents.length,
        rh: toHex(regHash),
        reg: registryEvents.slice(0, PAGE_SIZE),
        g: toHex(sig),
      },
      state.joiner.boxPublicKey,
    );
    const pages: Uint8Array[] = [];
    for (let at = PAGE_SIZE, i = 1; at < registryEvents.length; at += PAGE_SIZE, i++) {
      pages.push(
        seal(
          sodium,
          { t: "regpage", s: this.session, i, reg: registryEvents.slice(at, at + PAGE_SIZE) },
          state.joiner.boxPublicKey,
        ),
      );
    }
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
        pages,
        deviceAdded,
        certificate,
        device: { deviceId: subject.deviceId, name: state.name },
      },
    };
  }
}
