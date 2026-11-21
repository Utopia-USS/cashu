import { useProfile } from "@cashu/store-react";
import { useState } from "react";
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

/** Scrolls the Sync card into view and moves focus to its switch. */
function revealSync(): void {
  const section = document.getElementById("sync");
  section?.scrollIntoView({ block: "start" });
  section?.querySelector<HTMLElement>('[role="switch"]')?.focus();
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
  // Without a sync config there is no Sync card, and pairing a phone cannot work: no "Pair a phone".
  // Once the card was seen it stays offered, so a host handover during a pairing (the card hides while
  // the connection is down) never closes the pairing dialog.
  const withSync = sync.state.kind === "ready";
  const [syncSeen, setSyncSeen] = useState(false);
  if (withSync && !syncSeen) setSyncSeen(true);
  const goToSync = withSync ? { onGoToSync: revealSync } : {};
  return (
    <DevicesView
      state={devices}
      rows={rows}
      leaderAction={leaderAction}
      fetchPaused={fetchPaused}
      keepFetching={keepFetching}
      syncRow={<SyncRowView state={sync.state} />}
      {...(syncSeen || withSync ? { pairing } : {})}
      {...goToSync}
    />
  );
}
