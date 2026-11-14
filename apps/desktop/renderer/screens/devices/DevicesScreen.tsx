import { useProfile } from "@cashu/store-react";
import { PairingView } from "../pairing/PairingView.js";
import { usePairingScreen } from "../pairing/usePairingScreen.js";
import { DevicesView } from "./DevicesView.js";
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
  return (
    <div className="grid gap-6">
      <SyncRowView state={sync.state} />
      <PairingView
        state={pairing}
        {...(sync.state.kind === "ready" ? { onGoToSync: () => reveal("sync") } : {})}
      />
      <DevicesView
        state={devices}
        leaderAction={leaderAction}
        fetchPaused={fetchPaused}
        keepFetching={keepFetching}
        {...(sync.state.kind === "ready" ? { onGoToSync: () => reveal("sync") } : {})}
      />
    </div>
  );
}
