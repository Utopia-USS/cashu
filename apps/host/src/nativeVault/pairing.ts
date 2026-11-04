// Inviter side of device pairing on a native vault: the authority fingerprint an invite is bound to,
// invite registration, joiner binding and the keyed device.added append mirrored to the LAN carrier.
import { createHash } from "node:crypto";
import { decodeLanDescriptor } from "@cashu/host-protocol/pairing-lan";
import { devices, ownBatchDigest, type UnstampedEvent } from "@cashu/sync";
import type { PairingJournal } from "../pairing/journal.js";
import { failClosed, type NativeVaultContext } from "./context.js";
import { warnCause } from "./diagnostics.js";
import type { SessionGuards } from "./guards.js";
import { ensureOwnLanMirror } from "./lanMirror.js";
import type { NativeVaultSession } from "./types.js";

const MAX_CANDIDATE_BYTES = 72 * 1024 * 1024;

type PairingWrites = Pick<
  NativeVaultSession,
  "pairingStart" | "pairingRegisterInvite" | "pairingBindJoiner" | "pairingAppend"
>;

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
  const { entry, engine, candidate, pairingJournal, source, queue, now } = context;
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
  const pairingAppend: PairingWrites["pairingAppend"] = (input) =>
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
      const descriptor = decodeLanDescriptor(input.rendezvous, true);
      if (!descriptor || input.qr.length > 2_048) return "refused" as const;
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
          ip: descriptor.ip,
          port: descriptor.port,
          spki: descriptor.spki,
        }),
        "utf8",
      );
      if (candidateBytes > MAX_CANDIDATE_BYTES) return "refused" as const;
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
        phase: "may_append",
      });
      if (attempt.phase !== "may_append") return "refused" as const;
      try {
        await engine.write([event]);
        if ((await engine.inspectOwnBatch({ eids: [event.i], digest })) !== "committed")
          throw new Error("pairing_batch_unverified");
        if (!(await ensureOwnLanMirror(context))) throw new Error("pairing_mirror_unavailable");
        pairingJournal.mark(entry.vaultId, input.session, "completed", now());
        return "completed" as const;
      } catch (error) {
        // The exact authenticated batch is reconciled from the durable journal on reopen.
        warnCause("native_pairing_append_unknown", error);
        failClosed(context);
        return "outcome_unknown" as const;
      }
    });
  return { pairingStart, pairingRegisterInvite, pairingBindJoiner, pairingAppend };
}
