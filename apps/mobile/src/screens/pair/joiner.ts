// The phone's half of a pairing (platform-free: the services inject the relay client, the KeyStore
// writes and the vault list, so Node tests run it against the fake relay and a Node inviter).
//
// Order (the PAIRING COMMIT POINT, m4-w2-exec): scan -> check the QR (a cashU code of this build's sync
// project, not expired, no unsent changes of the same vault unless the owner said to discard them) ->
// claim the session at the relay -> hello / challenge / six digits / welcome (`devices.runJoiner` over
// `FirestorePairingLink`) -> READ this phone's member document from the server (the Mac writes it after
// the six digits: the one commit point) -> only then store anything durable: the identity and keyring
// (KeyStore), the vault log with the certificate and registry seed, then the `pairedVaults` entry.
// Until that read every failure or cancel leaves the phone as it was (the identity and keyring live in
// memory only and are dropped; the link closes). The member document is the outcome, never one "done"
// message: a lost welcome ack is not an error.

import type { PairedVault } from "@cashu/store/device";
import {
  crypto,
  devices,
  FirestorePairingLink,
  type FirestoreRest,
  FirestoreRestError,
  PairingLinkError,
  pairingSessionId,
} from "@cashu/sync/engine";
import type { JoinedVault } from "../../services/vaultBootstrap";
import type { PairEvent, PairFailure } from "./pairState";

/** The relay as the pairing uses it: the same anonymous identity the vault's transport will use. */
export interface PairingRelay {
  /** This build's sync project (the QR names the one its Mac uses: `fb1:<projectId>`). */
  readonly projectId: string;
  readonly rest: FirestoreRest;
  uid(): Promise<string>;
}

/** What this phone already holds of the vault a QR names. */
interface HeldVault {
  /** The profile's name as this phone knows it. */
  readonly name: string;
  /** Own changes the relay is not known to have. */
  readonly unpushed: boolean;
}

export interface PairingPorts {
  readonly sodium: crypto.Sodium;
  /** Undefined when this build has no sync set up. */
  readonly relay: PairingRelay | undefined;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Poll interval of the link and of the member read (default 1500 ms). */
  readonly pollMs?: number;
  /** How long the member document may take after the welcome (default 2 minutes). */
  readonly memberWaitMs?: number;
  /** The vault as this phone holds it, undefined when it does not. */
  held(vault: string): HeldVault | undefined;
  /** Push the held vault's own changes; resolves whether some are still unpushed. */
  pushHeld(vault: string): Promise<boolean>;
  /**
   * Keep the welcome (identity, keyring, log) under the vault's queue with its session closed;
   * rejects `unpushed_changes` unless `discardUnpushed`.
   */
  store(joined: JoinedVault, options: { readonly discardUnpushed: boolean }): Promise<void>;
  /** Add the `pairedVaults` entry (the log's copy first) and reopen the services over it. */
  add(entry: PairedVault): Promise<void>;
  /** The placeholder profile name until the first sync brings the real one. */
  readonly placeholderName: string;
}

/** Relay identifier in the QR, as the Mac writes it. */
function rendezvousOf(projectId: string): string {
  return `fb1:${projectId}`;
}

const DEFAULT_POLL_MS = 1500;
const MEMBER_WAIT_MS = 2 * 60_000;

/** A pairing failure as the flow shows it. */
class PairingStopped extends Error {
  readonly reason: PairFailure;
  constructor(reason: PairFailure) {
    super(`pairing ${reason}`);
    this.name = "PairingStopped";
    this.reason = reason;
  }
}

/** A protocol failure (`devices.PairingFailure`) as the flow shows it. */
function protocolFailure(reason: string): PairFailure {
  switch (reason) {
    case "expired":
      return "expired";
    case "aborted":
    case "sas_rejected":
    case "sas_mismatch":
    case "capacity":
      return "refused";
    default:
      return "failed";
  }
}

/** Any thrown error as the flow shows it. */
function failureOf(error: unknown): PairFailure {
  if (error instanceof PairingStopped) return error.reason;
  if (error instanceof PairingLinkError) {
    switch (error.code) {
      case "taken":
        return "taken";
      case "expired":
      case "timeout":
        return "expired";
      case "unavailable":
        return "offline";
      default:
        return "failed";
    }
  }
  if (error instanceof FirestoreRestError && error.code === "unavailable") return "offline";
  if (error instanceof Error && error.message === "unpushed_changes") return "unpushed";
  // Sign-up at the relay without a network rejects with a fetch TypeError.
  if (error instanceof TypeError) return "offline";
  return "failed";
}

/**
 * Check a scanned or pasted text before anything leaves the phone: `notACode` (not a cashU invite),
 * a failure (no sync, another project, expired), or the invite.
 */
function checkInvite(
  qr: string,
  ports: Pick<PairingPorts, "relay" | "now">,
):
  | { readonly kind: "notACode" }
  | { readonly kind: "failed"; readonly reason: PairFailure }
  | { readonly kind: "ok"; readonly invite: devices.Invite } {
  const invite = devices.decodeInvite(qr.trim());
  if (invite === undefined) return { kind: "notACode" };
  if (ports.relay === undefined) return { kind: "failed", reason: "no_sync" };
  if (invite.rendezvous !== rendezvousOf(ports.relay.projectId)) {
    return { kind: "failed", reason: "other_project" };
  }
  if (ports.now() > invite.expiresAt) return { kind: "failed", reason: "expired" };
  return { kind: "ok", invite };
}

/**
 * Wait until this phone's member document exists at the relay and names this device: the Mac admitted
 * it. Not there yet reads as a 404 (no rules) or a 403 (the rules let only members read it); both are
 * polled. A document naming another device is "not yet" too: the phone keeps one relay identity across
 * pairings, so a re-pairing finds the previous pairing's document (an older device id of this phone)
 * until the Mac overwrites it at the commit point. Only the deadline ends the wait: rejects
 * `PairingStopped("failed")` after `waitMs` (`offline` when the relay was unreachable at the last try).
 */
async function waitForMember(input: {
  readonly rest: FirestoreRest;
  readonly vault: string;
  readonly uid: string;
  readonly device: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
  readonly waitMs: number;
  readonly cancelled: () => boolean;
}): Promise<void> {
  const path = `vaults/${input.vault}/members/${input.uid}`;
  const deadline = input.now() + input.waitMs;
  let unreachable = false;
  for (;;) {
    if (input.cancelled()) throw new PairingLinkError("closed");
    let doc: Awaited<ReturnType<FirestoreRest["get"]>>;
    try {
      doc = await input.rest.get(path);
      unreachable = false;
    } catch (error) {
      if (!(error instanceof FirestoreRestError)) throw error;
      if (error.code !== "permission-denied") unreachable = error.code === "unavailable";
      doc = undefined;
    }
    if (doc !== undefined) {
      const device = doc.fields.device;
      const named =
        device !== undefined && "stringValue" in device ? device.stringValue : undefined;
      if (named === input.device) return;
    }
    if (input.now() >= deadline) throw new PairingStopped(unreachable ? "offline" : "failed");
    await input.sleep(input.pollMs);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One pairing run. `start` drives the flow through `dispatch` (`pairReducer` events) and resolves when
 * it stopped (stored, failed, or cancelled); it never rejects. `cancel` is honoured until the member
 * document was read; after that the pairing is committed and finishes.
 */
export class PhonePairing {
  readonly #ports: PairingPorts;
  readonly #dispatch: (event: PairEvent) => void;
  #cancelled = false;
  #committed = false;
  /** The phone was wiped: nothing more is stored, even after the commit point. */
  #discarded = false;
  #link: FirestorePairingLink | undefined;
  #joiner: devices.PairingJoiner | undefined;
  /** The claim in flight (an abort can be written only once this phone is the session's joiner). */
  #claim: Promise<void> | undefined;
  /** The last protocol send in flight: an abort goes after it (both take the link's next number). */
  #sending: Promise<void> = Promise.resolve();

  constructor(ports: PairingPorts, dispatch: (event: PairEvent) => void) {
    this.#ports = ports;
    this.#dispatch = dispatch;
  }

  /**
   * Stop before the commit point (dispatches `cancel`): the link closes, the Mac is told (best effort),
   * nothing is kept. Does nothing once the member document was read.
   */
  cancel(): void {
    if (this.#committed || this.#cancelled) return;
    this.abandon();
    this.#dispatch({ type: "cancel" });
  }

  /**
   * `cancel` without the event (the flow already moved on: the six digits expired, a new scan). Once the
   * hello may have left (the session claimed, before the welcome), the Mac is told with an abort: a
   * joiner cannot release the session (only the vault's admin may delete it), so the abort is what ends
   * the Mac's wait at once instead of at its timeout.
   */
  abandon(): void {
    if (this.#committed || this.#cancelled) return;
    this.#cancelled = true;
    const link = this.#link;
    const joiner = this.#joiner;
    if (link === undefined) return;
    const claim = this.#claim;
    const sending = this.#sending;
    void (async () => {
      try {
        // After the claim and any send in flight: the abort must not race the hello for its number.
        await claim;
        await sending.catch(() => undefined);
        // An abort the Mac reads ends its wait at once; a lost one only delays its own timeout.
        const state = joiner?.state;
        const abort =
          state === "hello" || state === "sas" ? joiner?.rejectPending().reply : undefined;
        if (abort !== undefined) await link.send(abort);
      } catch {
        // Best effort.
      } finally {
        await link.close().catch(() => undefined);
      }
    })();
  }

  /**
   * The phone is being wiped: stop like `abandon`, and after the commit point store nothing more (the
   * services the ports reach are the wiped phone's fresh ones).
   */
  discard(): void {
    this.#discarded = true;
    this.abandon();
  }

  /**
   * Scan result -> stored vault. `discardUnpushed`: the owner agreed to remove unsent changes of a
   * vault this phone already holds.
   */
  async start(qr: string, name: string, options: { discardUnpushed: boolean }): Promise<void> {
    const ports = this.#ports;
    const checked = checkInvite(qr, ports);
    if (checked.kind === "notACode") {
      this.#dispatch({ type: "notACode" });
      return;
    }
    if (checked.kind === "failed") {
      this.#dispatch({ type: "failed", reason: checked.reason });
      return;
    }
    const invite = checked.invite;
    const relay = ports.relay as PairingRelay;
    const held = ports.held(invite.vaultId);
    if (held?.unpushed && !options.discardUnpushed) {
      // Try to deliver them first; ask only when they still cannot go.
      const still = await ports.pushHeld(invite.vaultId).catch(() => true);
      if (this.#cancelled) return;
      if (still) {
        this.#dispatch({ type: "discardAsked", profile: held.name, qr });
        return;
      }
    }
    this.#dispatch({ type: "connecting" });
    let joined: JoinedVault | undefined;
    try {
      joined = await this.#join(invite, qr, name, relay);
      if (this.#cancelled) return;
      // Committed: the Mac admitted this phone. Every step from here converges when repeated.
      this.#committed = true;
      this.#dispatch({ type: "storing" });
      if (this.#discarded) return;
      await ports.store(joined, options);
      if (this.#discarded) return;
      await ports.add({
        vaultId: invite.vaultId,
        deviceId: joined.identity.deviceId,
        role: "owner",
        pairedAt: ports.now(),
        name: ports.placeholderName,
      });
      this.#dispatch({ type: "stored", vault: invite.vaultId });
    } catch (error) {
      if (!this.#cancelled) this.#fail(error);
    } finally {
      // The KeyStore holds its own sealed copies once stored; the in-memory keys go either way.
      joined?.ring.wipe();
      joined?.identity.wipe();
      const link = this.#link;
      if (link !== undefined && !this.#cancelled) await link.close().catch(() => undefined);
    }
  }

  #fail(error: unknown): void {
    // After the commit point too (a KeyStore or file error while storing): the flow says it did not
    // finish; a new code from the Mac pairs again (every storing step converges when repeated).
    this.#dispatch({ type: "failed", reason: failureOf(error) });
  }

  /** Claim, run the protocol, read the member document: the welcome, nothing stored. */
  async #join(
    invite: devices.Invite,
    qr: string,
    name: string,
    relay: PairingRelay,
  ): Promise<JoinedVault> {
    const ports = this.#ports;
    const sleep = ports.sleep ?? defaultSleep;
    const pollMs = ports.pollMs ?? DEFAULT_POLL_MS;
    const uid = await relay.uid();
    if (this.#cancelled) throw new PairingLinkError("closed");
    const identity = crypto.createDeviceIdentity(ports.sodium);
    const started = devices.PairingJoiner.start(
      { sodium: ports.sodium, identity, name },
      qr.trim(),
      ports.now(),
    );
    if (!started.ok) throw new PairingStopped(protocolFailure(started.reason));
    this.#joiner = started.value.joiner;
    const link = new FirestorePairingLink({
      rest: relay.rest,
      uid: async () => uid,
      vault: invite.vaultId,
      sessionId: pairingSessionId(invite),
      side: "joiner",
      now: ports.now,
      sleep,
      pollMs,
    });
    this.#link = link;
    const claim = link.claim();
    this.#claim = claim.catch(() => undefined);
    await claim;
    if (this.#cancelled) throw new PairingLinkError("closed");
    let shown = false;
    let received = false;
    const counted: devices.PairingLink = {
      send: (message) => {
        if (this.#cancelled) return Promise.reject(new PairingLinkError("closed"));
        const sent = this.#sending
          .catch(() => undefined)
          .then(() => link.send(message))
          .catch((error: unknown) => {
            // The hello's slot already holds another message of this phone (only the claimant may write
            // there, and the claim found this phone's uid already in it): an earlier run of this phone
            // used the code, so it is taken, not a broken session.
            if (!received && error instanceof PairingLinkError && error.code === "malformed")
              throw new PairingStopped("taken");
            throw error;
          });
        this.#sending = sent;
        return sent;
      },
      receive: async () => {
        const message = await link.receive();
        received = true;
        if (shown && !this.#cancelled) this.#dispatch({ type: "part" });
        return message;
      },
    };
    const result = await devices.runJoiner(started.value.joiner, started.value.hello, counted, {
      now: ports.now,
      showSas: (sas) => {
        shown = true;
        if (!this.#cancelled) {
          this.#dispatch({ type: "sas", sas, expiresAt: ports.now() + devices.SAS_TTL_MS });
        }
      },
    });
    if (!result.ok) throw new PairingStopped(protocolFailure(result.reason));
    const welcome = result.value;
    try {
      await waitForMember({
        rest: relay.rest,
        vault: invite.vaultId,
        uid,
        device: identity.deviceId,
        now: ports.now,
        sleep,
        pollMs,
        waitMs: ports.memberWaitMs ?? MEMBER_WAIT_MS,
        cancelled: () => this.#cancelled,
      });
    } catch (error) {
      welcome.ring.wipe();
      identity.wipe();
      throw error;
    }
    return {
      identity,
      ring: welcome.ring,
      certificate: welcome.certificate,
      registryEvents: welcome.registryEvents,
      inviter: welcome.inviter,
    };
  }
}
