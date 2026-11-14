// Device pairing over the sync relay (M4): the Mac shows the QR, the joiner (a phone) claims the
// session at the relay and the pairing protocol (`devices.runInviter`) runs over a
// `FirestorePairingLink` of this Mac's relay identity. The link only moves sealed boxes; every
// security property comes from the protocol.
//
// ONE commit point: the joiner's relay membership (`members/{joinerUid}`, role `member`), written once
// the owner typed the six digits and the welcome and all its pages were written to the session. Before
// it, every cancel, expiry or failure closes the link (the session document and its messages are
// deleted) and leaves nothing that blocks a new invite: the in-memory invite ends, the journal keeps
// only an idle invite record (pruned after a day) and the joiner, which stores nothing before it read
// its own membership, keeps nothing either. Every check that can refuse runs BEFORE the membership, in
// the same turn of the vault queue as the membership write and the append (nativeVault/pairing.ts
// `pairingAdmit`), behind a durable `admitting` row. After it nothing refuses: the `device.added`
// append is keyed in the journal and retried until it lands (reopen included), an unknown membership
// outcome is resolved from the relay's member list (members.ts), and a member document no registry
// device and no live row explains is removed. The outcome the desktop reads comes from that persisted
// state, never from one message of the joiner: `completed` once the joiner's first signed head reached
// this Mac through the relay, `waiting_for_phone` while the admission is done but the phone has not
// synced yet.
//
// Session bound: the QR is good for its 5 minutes (the protocol's invite TTL, the first claim), but the
// relay session must outlive the whole exchange, since the relay refuses every message after its
// `expiresAt`: QR expiry + the 2-minute code window + PAIRING_WELCOME_WINDOW_MS (3 minutes) for the
// welcome pages, i.e. 10 minutes after the invite. A welcome is not started with less than that window
// left; one the session's end still cuts off (a stalled relay) fails before the commit point, so the
// host ends clean (link closed, invite released, nothing appended) and a new code pairs again.
import type {
  PairingCancelResult,
  PairingConfirmResult,
  PairingInspectResult,
  PairingInviteResult,
} from "@cashu/host-protocol";
import { mintUlid } from "@cashu/store";
import {
  devices,
  type FirestorePairingLink,
  FirestoreRestError,
  PairingLinkError,
  pairingSessionId,
} from "@cashu/sync";
import type { NativeVaultSession } from "../nativeVault.js";
import type { HostRelay } from "../relay/service.js";

const MAX_INVITES = 1;
/** Reserved after the code for writing the welcome and its pages to the session. */
export const PAIRING_WELCOME_WINDOW_MS = 3 * 60_000;
/** How long past the code window a joiner that sent its hello but never revealed is waited for. */
const REVEAL_GRACE_MS = 60_000;
/**
 * How long a finished session stays at the relay so the joiner can read the last pages: the link's
 * own grace past `expiresAt` (no write is accepted after it, so nothing new can arrive).
 */
const RETIRE_GRACE_MS = 60_000;
const PRUNE_EVERY_MS = 15_000;
/**
 * How long an invitation the phone cancelled stays answerable in memory (`inspect` says
 * `phone_cancelled`); after it the journal's answer is `not_started`.
 */
const PHONE_CANCELLED_KEEP_MS = 60_000;

type CodeResolver = (value: string | undefined) => void;

interface LiveInvite {
  readonly vault: string;
  readonly operationId: string;
  readonly link: FirestorePairingLink;
  /** The QR's own expiry (no claim, no hello after it). */
  readonly qrExpiresAt: number;
  /** The relay session's expiry (see the header). */
  readonly sessionExpiresAt: number;
  /** The relay uid that claimed the session, bound when its hello was accepted. */
  joinerUid?: string;
  joinerDevice?: string;
  helloAt?: number;
  code?: CodeResolver;
  earlyCode?: string;
  /** The owner typed a code: the commit may be under way, cancel is refused. */
  dispatched?: boolean;
  codeResult?: (result: PairingConfirmResult) => void;
  outcome?: PairingConfirmResult;
  /** The membership may have been written (the commit point may have passed). */
  committed?: boolean;
  /**
   * The owner cancelled before the commit point: the membership write is never started. Set and read
   * in one synchronous step each (cancel, the admission's `admit`), so exactly one of them wins.
   */
  cancelled?: boolean;
  /** The run (protocol, commit, settle); a cancel during the commit waits for it. */
  done?: Promise<void>;
  /** Stops watching for the phone's first sync (`waiting_for_phone` until `completed`). */
  stopWatch?: () => void;
  /** When the session is closed at the relay and the invite forgotten. */
  retireAt?: number;
  /**
   * The peer watch (a message of the joiner while the owner types the digits): its abort stops the
   * watching read at once (no relay request after it) once the commit point is passed or the pairing
   * ended; otherwise the read would poll the finished session until it closes at retirement.
   */
  peerWatch?: AbortController;
  /** The joiner left the pairing (its abort, or any message after its reveal): `phone_cancelled`. */
  phoneLeft?: boolean;
  closing?: Promise<void>;
}

export interface PairingService {
  invite(vault: string): Promise<PairingInviteResult>;
  confirm(vault: string, operationId: string, code: string): Promise<PairingConfirmResult>;
  inspect(vault: string, operationId: string): Promise<PairingInspectResult>;
  cancel(vault: string, operationId: string): Promise<PairingCancelResult>;
  /** Ends every invite and deletes its relay session (before the relay closes). */
  close(): Promise<void>;
  /** Invites still waiting for a joiner or the owner (the host does not idle out meanwhile). */
  pending(): number;
}

export interface PairingServiceInput {
  /** The current checked session of a vault (host sessions may be replaced). */
  readonly vault: (vaultId: string) => NativeVaultSession | undefined;
  readonly relay: Pick<
    HostRelay,
    | "configured"
    | "projectId"
    | "status"
    | "pairingLink"
    | "addMember"
    | "listMembers"
    | "requestPull"
    | "watchPairing"
    | "pruneExpiredPairings"
  >;
  readonly now: () => number;
  /** Value-free warnings (an event name and the error class). */
  readonly warn: (event: string, error: unknown) => void;
  /** Test seam: the prune timer (default every 15 s, unref'd). */
  readonly every?: (ms: number, run: () => void) => () => void;
}

const nodeEvery = (ms: number, run: () => void): (() => void) => {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
};

export function createPairingService(input: PairingServiceInput): PairingService {
  const { relay, now, warn } = input;
  const invites = new Map<string, LiveInvite>();
  let closed = false;
  let starting = false;

  const active = (live: LiveInvite) => live.outcome === undefined;

  /** Closes the relay session once (its messages and document are deleted); never throws. */
  const closeLink = (live: LiveInvite): Promise<void> => {
    live.closing ??= live.link.close().catch((error: unknown) => {
      // The session expires at the relay anyway (no write is accepted after it).
      warn("pairing.close-failed", error);
    });
    return live.closing;
  };

  /**
   * Pushes the vault's device list again with a new pairing revision, so a pairing screen asks
   * `inspect` again (the push the Devices screen already listens to; no timer on the desktop).
   */
  const changed = (live: LiveInvite) => {
    try {
      input.vault(live.vault)?.pairingChanged();
    } catch (error) {
      warn("pairing.push-failed", error);
    }
  };

  /** Ends an invite that is still running (cancel, expiry): no commit happened, nothing is kept. */
  const abandon = (
    live: LiveInvite,
    code: "expired" | "invalid" | "phone_cancelled",
  ): Promise<void> => {
    live.peerWatch?.abort();
    live.outcome = { kind: "refused", code };
    live.retireAt = code === "phone_cancelled" ? now() + PHONE_CANCELLED_KEEP_MS : now();
    live.code?.(undefined);
    live.code = undefined;
    live.codeResult?.(live.outcome);
    live.codeResult = undefined;
    changed(live);
    return closeLink(live);
  };

  /**
   * After `waiting_for_phone`: each device change (a sync pass settled) checks whether the phone's
   * first signed head arrived, and pushes once it did. Ends with `completed`, retirement or close.
   * Meanwhile the relay pulls the vault every 5 s (at most 3 minutes after the admission), so the
   * phone's first frames reach this Mac in seconds instead of on the next 5-minute pull.
   */
  const watchFirstSync = (live: LiveInvite, vault: NativeVaultSession) => {
    let checking = false;
    const check = () => {
      if (checking || live.outcome?.kind !== "waiting_for_phone") return;
      checking = true;
      void vault
        .pairingOperation(live.operationId)
        .then(
          (persisted) => {
            if (
              persisted?.phase !== "completed" ||
              !persisted.joinerSeen ||
              live.outcome?.kind !== "waiting_for_phone"
            )
              return;
            live.outcome = {
              kind: "completed",
              operationId: live.operationId,
              device: persisted.device,
            };
            live.stopWatch?.();
            live.stopWatch = undefined;
            vault.pairingChanged();
          },
          (error: unknown) => warn("pairing.outcome-unread", error),
        )
        .finally(() => {
          checking = false;
        });
    };
    const offDevices = vault.onDevicesChanged(check);
    const stopPulls = relay.watchPairing(live.vault);
    live.stopWatch = () => {
      offDevices();
      stopPulls();
    };
  };

  /**
   * While the owner types the six digits the protocol reads nothing from the link, so the phone's
   * abort (sent when it leaves the digits step) would wait unread until the code window ends. This
   * reads the joiner's next message meanwhile. The link takes messages only from the session's
   * claimant, and after its reveal a joiner sends nothing but an abort until the welcome, so ANY such
   * message means the phone left (it can only end its own pairing). Before the digits were typed the
   * invite ends at once; while a typed code is being committed, the membership write is not started
   * (`admit` reads `cancelled`) and the outcome says so. Ends with the link (close, expiry, timeout).
   */
  const watchPeer = (live: LiveInvite) => {
    if (live.peerWatch !== undefined) return;
    live.peerWatch = new AbortController();
    live.link.receive({ signal: live.peerWatch.signal }).then(
      () => {
        if (live.outcome !== undefined || live.committed) return;
        live.phoneLeft = true;
        live.cancelled = true;
        if (!live.dispatched) void abandon(live, "phone_cancelled");
      },
      () => {
        // The link closed or the session ended: the run settles on its own.
      },
    );
  };

  const prune = () => {
    const at = now();
    for (const [operationId, live] of invites) {
      if (active(live)) {
        if (live.dispatched) {
          // The commit may be running; only the relay session's end stops it (the link refuses).
          continue;
        }
        const deadline =
          live.helloAt === undefined
            ? live.qrExpiresAt
            : Math.min(live.sessionExpiresAt, live.helloAt + devices.SAS_TTL_MS + REVEAL_GRACE_MS);
        if (at > deadline) void abandon(live, "expired");
        continue;
      }
      if (live.retireAt !== undefined && at >= live.retireAt) {
        live.stopWatch?.();
        live.stopWatch = undefined;
        void closeLink(live);
        invites.delete(operationId);
      }
    }
  };
  const stopPruning = (input.every ?? nodeEvery)(PRUNE_EVERY_MS, prune);

  /**
   * The commit, after the whole welcome was written: `pairingAdmit` runs every refusable check, the
   * relay preflight and the durable `admitting` row, then the joiner's relay membership (the commit
   * point) and the keyed append. Throws when nothing was admitted or the outcome is unknown.
   */
  const commit = async (
    live: LiveInvite,
    vault: NativeVaultSession,
    session: string,
    welcome: devices.InviterWelcome,
    authority: string,
    qr: string,
  ): Promise<void> => {
    const uid = live.joinerUid;
    const device = welcome.device.deviceId;
    if (uid === undefined || device !== live.joinerDevice) throw new Error("pairing_unbound");
    if (live.cancelled) throw new Error("pairing_cancelled");
    const admitted = await vault.pairingAdmit(
      { session, operationId: live.operationId, welcome, authority, qr, uid },
      {
        preflight: async () => {
          await relay.listMembers(live.vault);
        },
        admit: async () => {
          // The owner's cancel won the race: the commit point is never passed, `pairingAdmit` marks
          // the attempt not_started. Checked in the same synchronous step that passes it.
          if (live.cancelled) return "absent";
          // An earlier pairing of the same phone (same uid, older device) is overwritten in place:
          // the member document is keyed by the uid, the relay drops the stale setting entry.
          live.committed = true;
          // Past the commit point a message of the phone changes nothing: stop reading the session.
          live.peerWatch?.abort();
          try {
            await relay.addMember(live.vault, { device, uid, role: "member" });
            return "admitted";
          } catch (error) {
            warn("pairing.member-write-failed", error);
            // A refusal the relay answered wrote nothing; anything else may still land.
            if (
              (error instanceof FirestoreRestError &&
                (error.code === "permission-denied" || error.code === "invalid-argument")) ||
              (error instanceof Error && error.message === "relay_off")
            )
              return "absent";
            return "unknown";
          }
        },
      },
    );
    if (admitted === "outcome_unknown") {
      live.outcome = { kind: "outcome_unknown", operationId: live.operationId };
      throw new Error("pairing_admit_unknown");
    }
    if (admitted === "refused") {
      live.committed = false;
      throw new Error("pairing_admit_refused");
    }
    // The phone's first pull finds its device.added; its first push is what `completed` waits for.
    relay.requestPull(live.vault);
  };

  /** The persisted outcome of a finished run (the journal is the source of truth after the commit). */
  const settle = async (
    live: LiveInvite,
    vault: NativeVaultSession,
    result: devices.PairingStep<devices.InviterWelcome> | undefined,
    failure: "expired" | "unavailable",
  ): Promise<void> => {
    // The run ended: whatever the outcome, nothing more is read from the session.
    live.peerWatch?.abort();
    if (live.outcome?.kind === "refused" && !live.committed) {
      // Cancelled, expired or left by the phone meanwhile: the session is closed already.
      await closeLink(live);
      return;
    }
    let persisted: Awaited<ReturnType<NativeVaultSession["pairingOperation"]>>;
    try {
      persisted = await vault.pairingOperation(live.operationId);
    } catch (error) {
      warn("pairing.outcome-unread", error);
      persisted = undefined;
    }
    live.outcome =
      persisted?.phase === "completed"
        ? persisted.joinerSeen
          ? { kind: "completed", operationId: live.operationId, device: persisted.device }
          : { kind: "waiting_for_phone", operationId: live.operationId, device: persisted.device }
        : persisted?.phase === "may_append" ||
            persisted?.phase === "admitting" ||
            live.outcome?.kind === "outcome_unknown"
          ? { kind: "outcome_unknown", operationId: live.operationId }
          : {
              kind: "refused",
              // The phone's abort, a protocol refusal (wrong codes) vs the session's end or a relay
              // failure.
              code:
                live.phoneLeft || (result?.ok === false && result.reason === "aborted")
                  ? "phone_cancelled"
                  : result === undefined || result.ok
                    ? failure
                    : result.reason === "expired"
                      ? "expired"
                      : "invalid",
            };
    live.codeResult?.(live.outcome);
    live.codeResult = undefined;
    changed(live);
    if (live.outcome.kind === "refused" && live.outcome.code === "phone_cancelled") {
      live.retireAt = now() + PHONE_CANCELLED_KEEP_MS;
      await closeLink(live);
      return;
    }
    if (
      (live.outcome.kind === "completed" || live.outcome.kind === "waiting_for_phone") &&
      result?.ok === true
    ) {
      // The joiner may still be reading the pages: the session stays until it could not take more.
      live.retireAt = live.sessionExpiresAt + RETIRE_GRACE_MS;
      if (live.outcome.kind === "waiting_for_phone") watchFirstSync(live, vault);
      return;
    }
    live.retireAt = now();
    await closeLink(live);
  };

  const run = async (
    live: LiveInvite,
    vault: NativeVaultSession,
    inviter: devices.PairingInviter,
    authority: string,
    qr: string,
  ): Promise<void> => {
    let result: devices.PairingStep<devices.InviterWelcome> | undefined;
    let failure: "expired" | "unavailable" = "unavailable";
    try {
      result = await devices.runInviter(inviter, live.link, {
        now,
        eid: () => mintUlid(now()),
        afterHello: async (joiner) => {
          // The link accepted the hello only from the session's claimant: that uid is the joiner.
          const uid = await live.link.joinerUid();
          if (uid === undefined) throw new Error("pairing_unclaimed");
          if (!(await vault.pairingBindJoiner(inviter.session, joiner)))
            throw new Error("pairing_hello_unavailable");
          live.joinerUid = uid;
          live.joinerDevice = joiner.deviceId;
          live.helloAt = now();
          changed(live);
        },
        enterCode: (attemptsLeft) =>
          new Promise((resolve) => {
            // The reveal is in: from here on the protocol reads nothing until the welcome.
            watchPeer(live);
            if (attemptsLeft <= 0 || live.outcome !== undefined) {
              resolve(undefined);
              return;
            }
            if (live.earlyCode !== undefined) {
              const code = live.earlyCode;
              live.earlyCode = undefined;
              resolve(code);
              return;
            }
            // A wrong code: the owner may type again (the protocol counts the attempts).
            live.codeResult?.({ kind: "refused", code: "invalid" });
            live.codeResult = undefined;
            live.dispatched = false;
            live.code = resolve;
          }),
        beforeWelcome: async () => {
          // Not started when the session could end before its last page is written.
          if (now() + PAIRING_WELCOME_WINDOW_MS > live.sessionExpiresAt)
            throw new Error("pairing_window_short");
        },
      });
      if (result.ok) await commit(live, vault, inviter.session, result.value, authority, qr);
    } catch (error) {
      // The link failed (expired, closed, relay unreachable) or the commit could not run: the
      // persisted state decides below.
      warn("pairing.link-ended", error);
      if (
        (error instanceof PairingLinkError && error.code === "expired") ||
        now() >= live.sessionExpiresAt
      )
        failure = "expired";
    }
    await settle(live, vault, result, failure);
  };

  return {
    pending: () => [...invites.values()].filter(active).length + (starting ? 1 : 0),

    async invite(vaultId) {
      prune();
      if (closed || starting || [...invites.values()].filter(active).length >= MAX_INVITES)
        return { kind: "refused", code: "busy" };
      starting = true;
      try {
        const vault = input.vault(vaultId);
        if (!vault) return { kind: "refused", code: "unavailable" };
        if (!relay.configured || relay.projectId === undefined)
          return { kind: "refused", code: "no_config" };
        if (!relay.status(vaultId).enabled) return { kind: "refused", code: "relay_off" };
        // Sessions a crash or a failed close left behind (no live one is past its end + grace).
        void relay
          .pruneExpiredPairings(vaultId, RETIRE_GRACE_MS)
          .catch((error: unknown) => warn("pairing.prune-failed", error));
        const created = await vault.pairingStart(`fb1:${relay.projectId}`);
        if (!created.ok)
          return {
            kind: "refused",
            code:
              created.reason === "capacity"
                ? "capacity"
                : created.reason === "not_trusted"
                  ? "not_trusted"
                  : "unavailable",
          };
        const { inviter, qr, authority } = created.value;
        const qrExpiresAt = inviter.invite.expiresAt;
        const sessionExpiresAt = qrExpiresAt + devices.SAS_TTL_MS + PAIRING_WELCOME_WINDOW_MS;
        let link: FirestorePairingLink;
        try {
          link = relay.pairingLink(vaultId, pairingSessionId(inviter.invite));
        } catch {
          inviter.reject();
          return { kind: "refused", code: "relay_off" };
        }
        try {
          await link.open(sessionExpiresAt);
        } catch (error) {
          // Nothing was created at the relay that a later invite could meet (a new QR, a new id).
          warn("pairing.open-failed", error);
          inviter.reject();
          await link.close().catch(() => {});
          return { kind: "refused", code: "unavailable" };
        }
        const operationId = mintUlid(now());
        let registered = false;
        try {
          registered = await vault.pairingRegisterInvite(
            inviter.session,
            operationId,
            qr,
            qrExpiresAt,
          );
        } catch (error) {
          warn("pairing.register-failed", error);
        }
        if (!registered || closed) {
          inviter.reject();
          await link.close().catch(() => {});
          return { kind: "refused", code: "unavailable" };
        }
        const live: LiveInvite = {
          vault: vaultId,
          operationId,
          link,
          qrExpiresAt,
          sessionExpiresAt,
        };
        invites.set(operationId, live);
        live.done = run(live, vault, inviter, authority, qr).catch((error: unknown) =>
          warn("pairing.run-failed", error),
        );
        return { kind: "ready", operationId, qr, expiresAt: qrExpiresAt };
      } finally {
        starting = false;
      }
    },

    confirm(vault, operationId, code) {
      const live = invites.get(operationId);
      if (!live || live.vault !== vault || !/^[0-9]{6}$/.test(code))
        return Promise.resolve({ kind: "refused", code: "invalid" });
      if (live.outcome) return Promise.resolve(live.outcome);
      if (now() > live.sessionExpiresAt)
        return Promise.resolve({ kind: "refused", code: "expired" });
      if (live.codeResult || live.earlyCode !== undefined || live.dispatched)
        return Promise.resolve({ kind: "refused", code: "busy" });
      live.dispatched = true;
      return new Promise((resolve) => {
        live.codeResult = resolve;
        const enter = live.code;
        live.code = undefined;
        if (enter) enter(code);
        else live.earlyCode = code;
      });
    },

    async inspect(vaultId, operationId) {
      const live = invites.get(operationId);
      if (live !== undefined && live.vault !== vaultId) return { kind: "refused", code: "invalid" };
      const persisted = await input.vault(vaultId)?.pairingOperation(operationId);
      if (persisted?.phase === "completed") {
        if (persisted.joinerSeen) return { kind: "completed", operationId };
        // The admission is done; the phone's first sync has not reached this Mac yet.
        relay.requestPull(vaultId);
        return { kind: "waiting_for_phone", operationId };
      }
      if (persisted?.phase === "may_append" || persisted?.phase === "admitting")
        return { kind: "outcome_unknown", operationId };
      if (live === undefined) {
        if (!persisted) return { kind: "refused", code: "invalid" };
        return { kind: "not_started", operationId };
      }
      if (live.outcome?.kind === "completed" || live.outcome?.kind === "waiting_for_phone")
        return { kind: live.outcome.kind, operationId };
      if (live.outcome?.kind === "outcome_unknown") return { kind: "outcome_unknown", operationId };
      if (live.outcome?.kind === "refused" && live.outcome.code === "phone_cancelled")
        return { kind: "phone_cancelled", operationId };
      if (live.outcome?.kind === "refused") return { kind: "not_started", operationId };
      return { kind: "pending", operationId, phoneConnected: live.helloAt !== undefined };
    },

    async cancel(vaultId, operationId) {
      const live = invites.get(operationId);
      if (live !== undefined && live.vault !== vaultId) return { kind: "refused" };
      if (live === undefined) {
        // Retired from memory: only the journal can still say the phone was added.
        let persisted: Awaited<ReturnType<NativeVaultSession["pairingOperation"]>>;
        try {
          persisted = await input.vault(vaultId)?.pairingOperation(operationId);
        } catch (error) {
          warn("pairing.outcome-unread", error);
          persisted = undefined;
        }
        return persisted?.phase === "completed"
          ? { kind: "refused", code: "already_added" }
          : { kind: "refused" };
      }
      if (live.outcome === undefined && !live.committed) {
        // Before the commit point, the six digits typed or not: the membership write is never
        // started (`admit` reads `cancelled`), the session is deleted, the phone keeps nothing.
        live.cancelled = true;
        await abandon(live, "invalid");
        return { kind: "cancelled" };
      }
      // The membership write is under way: the answer is its outcome.
      if (live.outcome === undefined) await live.done;
      const outcome: PairingConfirmResult | undefined = live.outcome;
      if (outcome?.kind === "completed" || outcome?.kind === "waiting_for_phone")
        return { kind: "refused", code: "already_added" };
      // The admission refused after all (no membership written): nothing was kept on either side.
      if (outcome?.kind === "refused" && !live.committed) return { kind: "cancelled" };
      return { kind: "refused" };
    },

    async close() {
      closed = true;
      stopPruning();
      const closing: Promise<void>[] = [];
      for (const live of invites.values()) {
        live.peerWatch?.abort();
        live.stopWatch?.();
        live.stopWatch = undefined;
        if (active(live)) {
          live.outcome = { kind: "refused", code: "unavailable" };
          live.code?.(undefined);
          live.codeResult?.(live.outcome);
        }
        closing.push(closeLink(live));
      }
      invites.clear();
      await Promise.all(closing);
    },
  };
}
