import { useProfile } from "@cashu/store-react";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { usePairingScreen } from "../pairing/usePairingScreen.js";
import { DevicesView } from "./DevicesView.js";
import { deviceRows } from "./deviceRows.js";
import { SyncRowView } from "./SyncRowView.js";
import { fetchPausedLine } from "./syncStatusLine.js";
import { useDevicesScreen } from "./useDevicesScreen.js";
import { useKeepFetching } from "./useKeepFetching.js";
import { useLeaderAction } from "./useLeaderAction.js";
import { useSyncRow } from "./useSyncRow.js";

export function DevicesScreen() {
  const vault = useProfile();
  return <ScopedDevicesScreen key={vault} />;
}

/** Scrolls a section of this screen into view and moves focus to its first control. */
function reveal(id: string): void {
  const section = document.getElementById(id);
  section?.scrollIntoView({ block: "start" });
  section?.querySelector<HTMLElement>("button, select, input, summary")?.focus();
}

function ScopedDevicesScreen() {
  const devices = useDevicesScreen();
  const pairing = usePairingScreen();
  const ready = devices.list?.kind === "ready" ? devices.list : null;
  const leaderAction = useLeaderAction(ready);
  const keepFetching = useKeepFetching(ready);
  const sync = useSyncRow();
  const fetchPaused = fetchPausedLine(
    devices.list?.kind === "ready" ? devices.list.leader.paused : undefined,
    sync.status,
  );
  const today = useCalendarDay();
  // Today's rule for changing the fetching device: the leader warning (36 hours without a fetch),
  // never while this Mac's own fetch is paused (the override takes its place).
  const rows =
    ready === null
      ? []
      : deviceRows(ready, today, ready.leader.warn && !fetchPaused && leaderAction.available);
  const goToSync = sync.state.kind === "ready" ? { onGoToSync: () => reveal("sync") } : {};
  return (
    <DevicesView
      state={devices}
      rows={rows}
      leaderAction={leaderAction}
      fetchPaused={fetchPaused}
      keepFetching={keepFetching}
      syncRow={<SyncRowView state={sync.state} />}
      pairing={pairing}
      {...goToSync}
    />
  );
}
