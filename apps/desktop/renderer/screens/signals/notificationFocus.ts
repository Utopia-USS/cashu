import type { ReadySignals } from "@cashu/store/investments/signals-screen";
import { signalGroups } from "./presentation.js";

/** Open only a group that still contains the exact live signal in this vault's fresh query. */
export function notificationSignalGroup(data: ReadySignals, signalId: string): string | null {
  const row = data.open.find((signal) => signal.gid === signalId);
  if (
    row === undefined ||
    row.status !== "active" ||
    !row.current ||
    row.snoozed ||
    row.decisions.length > 0
  )
    return null;
  return (
    signalGroups(data.open, data.held, "all").find((group) =>
      group.live.some((signal) => signal.gid === signalId),
    )?.key ?? null
  );
}
