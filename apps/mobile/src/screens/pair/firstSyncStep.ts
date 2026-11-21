// The first sync's step on the pairing screen, from the vault's status (pure: tested in Node).
import type { VaultSyncStatus } from "../../services/vaultEngine";

/**
 * One step of the first sync, each with its own line and its own bar (`done` of `total`, counted, never
 * estimated): `receiving` bytes that arrived of those the Mac's sync holds, `saving` the same bytes once
 * in this phone's copy (`events` saved so far), `checking` the copy's frames verified of those to verify.
 */
export type FirstSyncStep =
  | { readonly step: "receiving"; readonly done: number; readonly total: number }
  | {
      readonly step: "saving";
      readonly done: number;
      readonly total: number;
      readonly events: number;
    }
  | { readonly step: "checking"; readonly done: number; readonly total: number };

/** The step a vault's status shows: the replay check wins, then the pass's own counts. */
export function firstSyncStep(status: VaultSyncStatus | undefined): FirstSyncStep | null {
  if (status === undefined) return null;
  const replay = status.replay;
  if (replay !== undefined && replay.total > 0)
    return { step: "checking", done: replay.done, total: replay.total };
  const progress = status.progress;
  if (progress === undefined || progress.total === 0) return null;
  return progress.phase === "receiving"
    ? { step: "receiving", done: progress.done, total: progress.total }
    : { step: "saving", done: progress.done, total: progress.total, events: progress.events };
}
