import { deviceListResultSchema, type RelayStatusResult } from "@cashu/host-protocol";
import { deviceListState } from "@cashu/store/core/desktop-settings";
import { useConnection, useProfile, useQuery } from "@cashu/store-react";
import { useEffect, useState } from "react";
import { relayBridge } from "./relayBridge.js";
import { fetchPausedLine } from "./syncStatusLine.js";

/**
 * The paused bank fetch for screens outside Devices (Banking): the host's `leader.paused` from the live
 * device list, and which text fits from the sync switch (read once per push while paused, no timer).
 * Null while nothing is paused or the switch is still being read.
 */
export function useFetchPaused(): "outage" | "sync_off" | null {
  const vault = useProfile();
  const connection = useConnection();
  const bridge = relayBridge();
  const online = connection === "online" || connection === "recovered";
  const live = useQuery(deviceListState, { privacy: false });
  const parsed = live.status === "ready" ? deviceListResultSchema.safeParse(live.list) : null;
  const paused =
    online && parsed?.success && parsed.data.kind === "ready"
      ? parsed.data.leader.paused
      : undefined;
  const [read, setRead] = useState<{ vault: string; status: RelayStatusResult } | null>(null);
  useEffect(() => {
    if (paused === undefined || !bridge || !online) return;
    let current = true;
    bridge.status({ vault }).then(
      (status) => {
        if (current) setRead({ vault, status });
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [vault, bridge, online, paused, live]);
  if (paused === undefined) return null;
  // No sync on this host at all: the sync-off text needs no read.
  if (!bridge) return fetchPausedLine(paused, null);
  return read?.vault === vault ? fetchPausedLine(paused, read.status) : null;
}
