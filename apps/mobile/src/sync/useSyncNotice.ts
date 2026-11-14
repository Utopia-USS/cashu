// One vault's sync as Today shows it in its banner slot: a quiet status line (paused, today's limit,
// changes that can't be read, the replay check after ~1 s) or a notice that asks the owner (removed,
// sync turned off on the Mac, a profile that does not open) with "Remove this copy" offered, never run
// by itself. "Keep for now" hides the sync-off notice until the next launch.
import { useEffect, useState, useSyncExternalStore } from "react";
import { S } from "./Sync.strings";
import { REPLAY_LINE_AFTER_MS, syncLineOf, vaultNoticeOf } from "./syncStatusCopy";
import { useVaultSyncStatus } from "./usePhoneSync";

interface SyncNoticeAction {
  readonly label: string;
  readonly tone: "danger" | "secondary";
  onPress(): void;
}

export interface SyncSlot {
  /** The quiet line; null when there is nothing to say. */
  readonly line: { readonly text: string; readonly tone: "muted" | "warning" } | null;
  /** A state that asks the owner; null when none. */
  readonly notice: {
    /** Which state asks: removed (#23.7), sync turned off on the Mac (#25.4), a profile that does not open. */
    readonly kind: "removed" | "syncOff" | "needsRepair";
    readonly title: string;
    readonly body: string | null;
    readonly actions: readonly SyncNoticeAction[];
    /** "Remove this copy" failed. */
    readonly failed: boolean;
  } | null;
}

/** Sync-off notices put aside with "Keep for now" this launch. */
const keptForNow = new Set<string>();
const keptListeners = new Set<() => void>();
const subscribeKept = (listener: () => void) => {
  keptListeners.add(listener);
  return () => keptListeners.delete(listener);
};
let keptVersion = 0;
const keptSnapshot = () => keptVersion;

function keepForNow(vault: string): void {
  keptForNow.add(vault);
  keptVersion++;
  for (const listener of [...keptListeners]) listener();
}

export function useSyncNotice(args: {
  readonly vault: string;
  readonly profile: string;
  /** Remove this vault's copy from the phone (`forgetThisVault`). */
  removeCopy(vault: string): Promise<void>;
  /** Open the pairing modal (a profile that does not open); no "Pair again" button without it. */
  pairAgain?: () => void;
}): SyncSlot {
  const status = useVaultSyncStatus(args.vault);
  useSyncExternalStore(subscribeKept, keptSnapshot, keptSnapshot);
  const [failed, setFailed] = useState(false);
  // The replay line shows once a replay ran REPLAY_LINE_AFTER_MS; set (and cleared) from a timer.
  const [shown, setShown] = useState(false);
  const replaying = status?.replay !== undefined;
  useEffect(() => {
    const timer = setTimeout(() => setShown(replaying), replaying ? REPLAY_LINE_AFTER_MS : 0);
    return () => clearTimeout(timer);
  }, [replaying]);
  const replayShown = replaying && shown;

  const remove: SyncNoticeAction = {
    label: S.removeCopy,
    tone: "danger",
    onPress: () => {
      setFailed(false);
      args.removeCopy(args.vault).catch(() => setFailed(true));
    },
  };
  const notice = vaultNoticeOf(status);
  if (notice !== null) {
    switch (notice.kind) {
      case "removed":
        return {
          line: null,
          notice: {
            kind: "removed",
            title: S.removed(args.profile),
            body: S.removedBody,
            actions: [remove],
            failed,
          },
        };
      case "syncOff":
        if (keptForNow.has(args.vault)) return { line: null, notice: null };
        return {
          line: null,
          notice: {
            kind: "syncOff",
            title: S.syncOff(args.profile),
            body: null,
            actions: [
              remove,
              {
                label: S.keepForNow,
                tone: "secondary",
                onPress: () => keepForNow(args.vault),
              },
            ],
            failed,
          },
        };
      case "needsRepair":
        return {
          line: null,
          notice: {
            kind: "needsRepair",
            title: S.needsRepair(args.profile),
            body: null,
            actions: [
              ...(args.pairAgain === undefined
                ? []
                : [{ label: S.pairAgain, tone: "secondary" as const, onPress: args.pairAgain }]),
              remove,
            ],
            failed,
          },
        };
    }
  }
  const line = syncLineOf(status, { replayShown });
  if (line === null) return { line: null, notice: null };
  switch (line.kind) {
    case "replay":
      return { line: { text: S.replay(line.percent), tone: "muted" }, notice: null };
    case "stuck":
      return {
        line: {
          text: stuckText(line),
          tone: line.failed ? "warning" : "muted",
        },
        notice: null,
      };
    case "quota":
      return { line: { text: S.quota, tone: "muted" }, notice: null };
    case "paused":
      return { line: { text: S.paused(line.since), tone: "muted" }, notice: null };
  }
}

/** The stuck line: the writer's registry name when known, else "another device" (never an id). */
function stuckText(line: { readonly device?: string; readonly failed: boolean }): string {
  if (line.device === undefined) return line.failed ? S.stuckFailedUnnamed : S.stuckWaitingUnnamed;
  return line.failed ? S.stuckFailed(line.device) : S.stuckWaiting(line.device);
}
