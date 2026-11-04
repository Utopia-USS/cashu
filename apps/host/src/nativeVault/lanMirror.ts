// This device's own log segments mirrored byte-for-byte into the LAN carrier folder, which a pairing
// joiner reads before it is trusted. A pairing is complete only once its batch is mirrored there.
import type { FolderTransport, SyncEngine } from "@cashu/sync";
import type { HostLanCarrier } from "../pairing/carrier.js";
import type { PairingJournal } from "../pairing/journal.js";
import type { NativeVaultInventoryEntry } from "../sync/keys/deviceAuthority.js";

interface MirrorInput {
  readonly entry: NativeVaultInventoryEntry;
  readonly engine: SyncEngine;
  readonly localTransport: FolderTransport;
  readonly lanCarrier: HostLanCarrier;
}

/** Pushes, then checks every own segment is present in the carrier with the same bytes. */
export async function ensureOwnLanMirror(input: MirrorInput): Promise<boolean> {
  const { entry, engine, localTransport, lanCarrier } = input;
  await engine.sync();
  const local = (await localTransport.list(entry.vaultId)).filter(
    (part) => part.device === entry.deviceId,
  );
  const mirror = new Map(
    (await lanCarrier.list(entry.vaultId))
      .filter((part) => part.device === entry.deviceId)
      .map((part) => [part.seg, part.size]),
  );
  for (const part of local) {
    if (mirror.get(part.seg) !== part.size) return false;
    const expected = await localTransport.read(entry.vaultId, entry.deviceId, part.seg, 0);
    const actual = await lanCarrier.read(entry.vaultId, entry.deviceId, part.seg, 0);
    if (!Buffer.from(expected).equals(Buffer.from(actual))) return false;
  }
  return true;
}

/**
 * At open: settles each pending pairing from the authenticated log. A committed batch completes only
 * once mirrored (all sizes are compared before any bytes); an absent one is marked not started.
 */
export async function reconcilePendingPairings(
  input: MirrorInput & { readonly pairingJournal: PairingJournal; readonly now: () => number },
): Promise<void> {
  const { entry, engine, localTransport, lanCarrier, pairingJournal, now } = input;
  for (const pending of pairingJournal.pending(entry.vaultId)) {
    const proof = await engine.inspectOwnBatch({ eids: [pending.eid], digest: pending.digest });
    if (proof === "committed") {
      await engine.sync();
      const local = (await localTransport.list(entry.vaultId)).filter(
        (part) => part.device === entry.deviceId,
      );
      const remote = new Map(
        (await lanCarrier.list(entry.vaultId))
          .filter((part) => part.device === entry.deviceId)
          .map((part) => [part.seg, part.size]),
      );
      let mirrored = local.every((part) => remote.get(part.seg) === part.size);
      for (const part of local) {
        if (!mirrored) break;
        const expected = await localTransport.read(entry.vaultId, entry.deviceId, part.seg, 0);
        const actual = await lanCarrier.read(entry.vaultId, entry.deviceId, part.seg, 0);
        mirrored = Buffer.from(expected).equals(Buffer.from(actual));
      }
      if (mirrored) pairingJournal.mark(entry.vaultId, pending.session, "completed", now());
    } else if (proof === "absent")
      pairingJournal.mark(entry.vaultId, pending.session, "not_started", now());
  }
}
