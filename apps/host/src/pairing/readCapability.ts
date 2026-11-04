import type { SyncEngine } from "@cashu/sync";
import type { NativeVaultSession } from "../nativeVault.js";
import type { WriteQueue } from "../queue.js";
import type { loadDeviceAuthority } from "../sync/keys/deviceAuthority.js";
import type { PairingJournal } from "./journal.js";

type PairingReads = Pick<
  NativeVaultSession,
  "pairingAttempt" | "pairingOperation" | "pairingHasActive" | "pairingKnown" | "pairingTrust"
>;

/** Read-side pairing proof stays serialized with writes and never mints a new attempt. */
export function pairingReadCapability(input: {
  readonly vault: string;
  readonly journal: PairingJournal;
  readonly engine: SyncEngine;
  readonly queue: WriteQueue;
  readonly registry: () => Awaited<ReturnType<typeof loadDeviceAuthority>>["devices"]["registry"];
  readonly isCurrent: () => boolean;
  readonly prune: () => void;
  readonly mirrorOwnBatch: () => Promise<boolean>;
  readonly now: () => number;
}): PairingReads {
  const { vault, journal, engine, queue, registry, isCurrent, prune, mirrorOwnBatch, now } = input;

  const reconcile = async (session: string) => {
    const attempt = journal.get(vault, session);
    if (!attempt || attempt.vault !== vault) return undefined;
    if (attempt.phase !== "may_append") return attempt;
    const proof = await engine.inspectOwnBatch({ eids: [attempt.eid], digest: attempt.digest });
    if (proof === "committed" && (await mirrorOwnBatch()))
      journal.mark(vault, session, "completed", now());
    else if (proof === "absent") journal.mark(vault, session, "not_started", now());
    return journal.get(vault, session);
  };

  return {
    pairingAttempt: (session) =>
      queue.run(async () => {
        prune();
        if (!isCurrent()) return undefined;
        return reconcile(session);
      }),
    pairingOperation: (operationId) =>
      queue.run(async () => {
        prune();
        if (!isCurrent()) return undefined;
        const attempt = journal.forOperation(vault, operationId);
        if (!attempt) return undefined;
        if (attempt.phase === "may_append") await reconcile(attempt.session);
        return journal.forOperation(vault, operationId);
      }),
    pairingHasActive: () =>
      queue.run(() => {
        if (!isCurrent()) return false;
        if (journal.pending(vault).length > 0) return true;
        for (const device of registry().trusted.keys())
          if (journal.forDevice(vault, device) !== undefined) return true;
        return false;
      }),
    pairingKnown: (device, purpose, session) =>
      queue.run(() => {
        if (!isCurrent()) return false;
        if (purpose === "carrier") return registry().isTrusted(device);
        if (!session) return false;
        const attempt = journal.get(vault, session);
        return (
          !!attempt &&
          attempt.device === device &&
          attempt.phase === "completed" &&
          registry().isTrusted(device)
        );
      }),
    pairingTrust: (device, signKey, boxKey, certificate) =>
      queue.run(() => {
        if (!isCurrent()) return false;
        const record = registry().trusted.get(device);
        const stored = journal.forDevice(vault, device);
        return (
          !!record &&
          !!stored &&
          Buffer.from(record.signPublicKey).equals(Buffer.from(signKey)) &&
          Buffer.from(record.boxPublicKey).equals(Buffer.from(boxKey)) &&
          stored.signKey === Buffer.from(signKey).toString("hex") &&
          stored.boxKey === Buffer.from(boxKey).toString("hex") &&
          stored.certificate === Buffer.from(certificate).toString("hex")
        );
      }),
  };
}
