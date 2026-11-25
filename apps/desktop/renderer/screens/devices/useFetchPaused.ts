import { deviceListResultSchema, type RelayStatusResult } from "@cashu/host-protocol";
import { deviceListState } from "@cashu/store/core/desktop-settings";
import { useConnection, useProfile, useQuery } from "@cashu/store-react";
import { useEffect, useState } from "react";
import { relayBridge } from "./relayBridge.js";
import { fetchPausedLine } from "./syncStatusLine.js";
import { type KeepFetchingState, useKeepFetching } from "./useKeepFetching.js";

export interface FetchPaused {
  /** Which text fits; null while nothing is paused or the switch is still being read. */
  readonly line: "outage" | "sync_off" | null;
  /** The same "Keep fetching on this Mac" override Devices offers (null: not offered). */
  readonly keepFetching: KeepFetchingState;
}

/**
 * The paused bank fetch for screens outside Devices (Banking): the host's `leader.paused` from the live
 * device list, which text fits from the sync switch (read once per push while paused, no timer), and
 * the owner's override. The caller remounts this hook per vault (as DevicesScreen does).
 */
export function useFetchPaused(): FetchPaused {
  const vault = useProfile();
  const connection = useConnection();
  const bridge = relayBridge();
  const online = connection === "online" || connection === "recovered";
  const live = useQuery(deviceListState, { privacy: false });
  const parsed = live.status === "ready" ? deviceListResultSchema.safeParse(live.list) : null;
  const ready = online && parsed?.success && parsed.data.kind === "ready" ? parsed.data : null;
  const paused = ready?.leader.paused;
  const keepFetching = useKeepFetching(ready);
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
  if (paused === undefined) return { line: null, keepFetching };
  // No sync on this host at all: the sync-off text needs no read.
  const line = !bridge
    ? fetchPausedLine(paused, null)
    : read?.vault === vault
      ? fetchPausedLine(paused, read.status)
      : null;
  return { line, keepFetching };
}
