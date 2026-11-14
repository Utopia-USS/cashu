// Inviter side of device pairing on a native vault: the authority fingerprint an invite is bound to,
// invite registration, joiner binding, the admission (the relay membership as the ONE commit point,
// then the keyed device.added append, pushed to the sync relay once) and the convergence of an
// admission a crash or a lost answer left open (`pairingResume`, `pairingResolve`).
import { createHash } from "node:crypto";
import { devices, ownBatchDigest, type UnstampedEvent } from "@cashu/sync";
import type { PairingAttempt, PairingJournal } from "../pairing/journal.js";
import { failClosed, type NativeVaultContext } from "./context.js";
import { warnCause } from "./diagnostics.js";
import type { SessionGuards } from "./guards.js";
import type { NativeVaultSession } from "./types.js";

const MAX_CANDIDATE_BYTES = 72 * 1024 * 1024;

type PairingWrites = Pick<
  NativeVaultSession,
  | "pairingStart"
  | "pairingRegisterInvite"
  | "pairingBindJoiner"
  | "pairingAdmit"
  | "pairingOperation"
  | "pairingAdmissions"
  | "pairingResolve"
  | "pairingResume"
>;

type AppendContext = Pick<
  NativeVaultContext,
  "entry" | "engine" | "candidate" | "pairingJournal" | "now"
>;

/**
 * At open: settles every owed append whose batch is already in the authenticated log. A `may_append`
 * row whose batch is absent stays owed (the membership exists: it is RE-APPENDED by `pairingResume`,
 * never marked `not_started`); an `admitting` row waits for the relay's member list.
 */
export async function reconcilePendingPairings(
  context: Pick<NativeVaultContext, "entry" | "engine" | "pairingJournal" | "now">,
): Promise<void> {
  const { entry, engine, pairingJournal, now } = context;
  for (const pending of pairingJournal.pending(entry.vaultId)) {
    if (pending.phase !== "may_append") continue;
    const proof = await engine.inspectOwnBatch({ eids: [pending.eid], digest: pending.digest });
    if (proof === "committed")
      pairingJournal.mark(entry.vaultId, pending.session, "completed", now());
  }
}

/**
 * The owed `device.added` of a row whose membership exists: appended (keyed by its eid and digest, so a
 * batch already in the log is never written twice) and marked `completed`. Throws when the write's
 * outcome is unknown; the row stays `may_append` and is retried.
 */
async function appendAdmitted(context: AppendContext, attempt: PairingAttempt): Promise<void> {
  const { entry, engine, candidate, pairingJournal, now } = context;
  const keyed = { eids: [attempt.eid], digest: attempt.digest };
  // A device the registry already holds is admitted in both places: nothing is owed any more.
  if (
    (await engine.inspectOwnBatch(keyed)) !== "committed" &&
    !candidate.devices.registry.isRegistered(attempt.device)
  ) {
    await engine.write([attempt.event]);
    if ((await engine.inspectOwnBatch(keyed)) !== "committed")
      throw new Error("pairing_batch_unverified");
  }
  pairingJournal.mark(entry.vaultId, attempt.session, "completed", now());
}

/** Prunes expired pairing receipts and invites at most once a minute (clock read at creation). */
export function pairingPruner(
  journal: PairingJournal,
  vault: string,
  now: () => number,
): () => void {
  let lastPruneAt = now();
  return () => {
    const at = now();
    if (at - lastPruneAt < 60_000) return;
    journal.pruneReceipts(vault, at);
    journal.pruneInvites(vault, at);
    lastPruneAt = at;
  };
}

/** Digest of the inviting authority (signer, ring, recovery keys, registry); changes on rotation. */
export function pairingAuthority(context: NativeVaultContext): string {
  const { entry, candidate } = context;
  const recovery = candidate.devices.registry.recovery;
  const active = candidate.ring.active;
  return createHash("sha256")
    .update(
      JSON.stringify({
        session: entry.deviceId,
        signer: Buffer.from(candidate.identity.signPublicKey).toString("hex"),
        ring: [active.kid, active.epoch, active.generation, candidate.ring.size],
        recovery: [
          Buffer.from(recovery.signPublicKey).toString("hex"),
          Buffer.from(recovery.boxPublicKey).toString("hex"),
        ],
        registryEvents: candidate.devices.registry.events,
      }),
    )
    .digest("hex");
}

export function pairingWrites(
  context: NativeVaultContext,
  guards: Pick<SessionGuards, "isCurrent" | "writesBlocked">,
  prunePairing: () => void,
): PairingWrites {
  const { entry, engine, candidate, pairingJournal, source, queue, state, lease, now } = context;
  const pairingStart: PairingWrites["pairingStart"] = (rendezvous) =>
    queue.run(() => {
      prunePairing();
      if (!guards.isCurrent() || guards.writesBlocked())
        return { ok: false, reason: "unavailable" } as const;
      const authority = pairingAuthority(context);
      const created = devices.PairingInviter.create({
        sodium: source.sodium,
        identity: candidate.identity,
        ring: candidate.ring,
        registry: candidate.devices.registry,
        now: now(),
        rendezvous,
      });
      return created.ok ? { ok: true, value: { ...created.value, authority } } : created;
    });
  const pairingRegisterInvite: PairingWrites["pairingRegisterInvite"] = (
    session,
    operationId,
    qr,
    expiresAt,
  ) =>
    queue.run(() => {
      if (!guards.isCurrent() || !Number.isSafeInteger(expiresAt) || expiresAt <= now())
        return false;
      pairingJournal.registerInvite({
        session,
        operationId,
        vault: entry.vaultId,
        qrDigest: createHash("sha256").update(qr).digest("hex"),
        expiresAt,
      });
      return true;
    });
  const pairingBindJoiner: PairingWrites["pairingBindJoiner"] = (session, joiner) =>
    queue.run(() => {
      if (!guards.isCurrent()) return false;
      const invite = pairingJournal.invite(entry.vaultId, session);
      if (!invite || now() > invite.expiresAt) return false;
      pairingJournal.bindJoiner(entry.vaultId, session, {
        device: joiner.deviceId,
        signKey: Buffer.from(joiner.signPublicKey).toString("hex"),
        boxKey: Buffer.from(joiner.boxPublicKey).toString("hex"),
      });
      return true;
    });
  /**
   * The pairing's commit point, in ONE turn of the vault queue (no pull, revocation or other write runs
   * in between, and a live row blocks them afterwards): every check that can refuse, the relay
   * preflight, the durable `admitting` row, the membership write, then the owed append. Before the
   * membership nothing is kept but a row that resolves to `not_started`; after it nothing refuses: the
   * append is retried (here, by `pairingResume` at open and after each relay pass) until it lands.
   */
  const pairingAdmit: PairingWrites["pairingAdmit"] = (input, membership) =>
    queue.run(async () => {
      if (!guards.isCurrent() || guards.writesBlocked()) return "refused" as const;
      if (input.authority !== pairingAuthority(context)) return "refused" as const;
      const registeredInvite = pairingJournal.invite(entry.vaultId, input.session);
      if (
        !registeredInvite ||
        registeredInvite.operationId !== input.operationId ||
        registeredInvite.qrDigest !== createHash("sha256").update(input.qr).digest("hex") ||
        registeredInvite.device !== input.welcome.device.deviceId
      )
        return "refused" as const;
      if (input.qr.length > 2_048) return "refused" as const;
      const event: UnstampedEvent = input.welcome.deviceAdded;
      const payload = event.d;
      if (
        event.t !== "device.added" ||
        typeof payload.device !== "string" ||
        payload.device !== input.welcome.device.deviceId ||
        typeof payload.signPublicKey !== "string" ||
        typeof payload.boxPublicKey !== "string" ||
        typeof payload.certificate !== "string" ||
        payload.signPublicKey !== registeredInvite.signKey ||
        payload.boxPublicKey !== registeredInvite.boxKey ||
        candidate.devices.registry.isRegistered(payload.device)
      )
        return "refused" as const;
      const candidateBytes = Buffer.byteLength(
        JSON.stringify({
          v: 1,
          vaultId: entry.vaultId,
          deviceId: payload.device,
          session: input.session,
          invite: input.qr,
          certificate: Buffer.from(input.welcome.certificate).toString("hex"),
          registryEvents: candidate.devices.registry.events.slice(0, devices.MAX_REGISTRY_EVENTS),
        }),
        "utf8",
      );
      if (candidateBytes > MAX_CANDIDATE_BYTES) return "refused" as const;
      // The relay must answer before anything is journalled: an unreachable relay refuses cleanly.
      try {
        await membership.preflight();
      } catch (error) {
        warnCause("native_pairing_relay_unreachable", error);
        return "refused" as const;
      }
      if (!guards.isCurrent()) return "refused" as const;
      const digest = ownBatchDigest([event]);
      const attempt = pairingJournal.prepare({
        session: input.session,
        operationId: input.operationId,
        vault: entry.vaultId,
        device: payload.device,
        signKey: payload.signPublicKey,
        boxKey: payload.boxPublicKey,
        certificate: payload.certificate,
        event,
        eid: event.i,
        digest,
        welcome: input.welcome.reply,
        pages: input.welcome.pages,
        phase: "admitting",
        uid: input.uid,
        touchedAt: now(),
      });
      if (attempt.phase !== "admitting") return "refused" as const;
      // ---- the commit point: the joiner's relay membership ----
      let admitted: "admitted" | "absent" | "unknown";
      try {
        admitted = await membership.admit();
      } catch (error) {
        warnCause("native_pairing_member_unknown", error);
        admitted = "unknown";
      }
      if (admitted === "absent") {
        pairingJournal.mark(entry.vaultId, input.session, "not_started", now());
        return "refused" as const;
      }
      if (admitted === "unknown") {
        // Resolved from the relay's member list by the reconciliation (members.ts); never refused.
        pairingJournal.touch(entry.vaultId, input.session, now());
        return "outcome_unknown" as const;
      }
      pairingJournal.mark(entry.vaultId, input.session, "may_append", now());
      try {
        await appendAdmitted(context, { ...attempt, phase: "may_append" });
      } catch (error) {
        // The exact authenticated batch is re-appended from the durable journal (reopen, resume).
        warnCause("native_pairing_append_unknown", error);
        failClosed(context);
        return "outcome_unknown" as const;
      }
      // One push now, so the joiner's first pull finds its device.added at the relay. A relay that
      // cannot be reached here is not a failure: the committed write already scheduled the relay's
      // own push, which retries until it lands.
      try {
        const pushed = await engine.sync();
        if (pushed.offlineRemotes > 0) warnCause("native_pairing_push_deferred", undefined);
      } catch (error) {
        warnCause("native_pairing_push_deferred", error);
      }
      return "completed" as const;
    });
  /** Owed appends (`may_append`) retried; a failure keeps the row and fails the session closed. */
  const resumeOwed = async (): Promise<void> => {
    for (const owed of pairingJournal.pending(entry.vaultId)) {
      if (owed.phase !== "may_append") continue;
      try {
        await appendAdmitted(context, owed);
      } catch (error) {
        warnCause("native_pairing_append_unknown", error);
        failClosed(context);
        return;
      }
    }
  };
  const pairingResume: PairingWrites["pairingResume"] = () =>
    queue.run(async () => {
      if (!state.current || !lease.held) return;
      await resumeOwed();
    });
  const pairingAdmissions: PairingWrites["pairingAdmissions"] = (members) =>
    queue.run(() => {
      if (!state.current || !lease.held) return undefined;
      return {
        registered: new Set(
          members.filter((device) => candidate.devices.registry.isRegistered(device)),
        ),
        live: pairingJournal.pending(entry.vaultId).map((row) => ({
          session: row.session,
          device: row.device,
          phase: row.phase,
          ...(row.uid === undefined ? {} : { uid: row.uid }),
          ...(row.touchedAt === undefined ? {} : { touchedAt: row.touchedAt }),
        })),
      };
    });
  const pairingResolve: PairingWrites["pairingResolve"] = (session, membership, listedAt) =>
    queue.run(async () => {
      if (!state.current || !lease.held) return;
      const row = pairingJournal.get(entry.vaultId, session);
      if (row?.phase !== "admitting") return;
      if (membership === "present") {
        pairingJournal.mark(entry.vaultId, session, "may_append", now());
        await resumeOwed();
        return;
      }
      // Absent only from a list read after the membership write had ended (a write still in flight,
      // or one that ended after the list started, may yet land: the next list decides).
      if (row.touchedAt !== undefined && listedAt > row.touchedAt)
        pairingJournal.mark(entry.vaultId, session, "not_started", now());
    });
  const pairingOperation: PairingWrites["pairingOperation"] = (operationId) =>
    queue.run(async () => {
      prunePairing();
      if (!guards.isCurrent()) return undefined;
      const attempt = pairingJournal.forOperation(entry.vaultId, operationId);
      if (attempt?.phase === "may_append") {
        const proof = await engine.inspectOwnBatch({ eids: [attempt.eid], digest: attempt.digest });
        if (proof === "committed")
          pairingJournal.mark(entry.vaultId, attempt.session, "completed", now());
      }
      const settled = pairingJournal.forOperation(entry.vaultId, operationId);
      if (settled === undefined) return undefined;
      // The engine copies a pulled frame into the local log only after its signed head verified: a
      // segment of the joiner there is its first signed head, received through the relay.
      const joinerSeen =
        settled.phase === "completed" &&
        (await context.localTransport.list(entry.vaultId)).some(
          (segment) => segment.device === settled.device && segment.size > 0,
        );
      return { ...settled, joinerSeen };
    });
  return {
    pairingStart,
    pairingRegisterInvite,
    pairingBindJoiner,
    pairingAdmit,
    pairingOperation,
    pairingAdmissions,
    pairingResolve,
    pairingResume,
  };
}
