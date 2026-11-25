import type { DeviceListResult } from "@cashu/host-protocol";
import { useConnection, useProfile } from "@cashu/store-react";
import { useEffect, useRef, useState } from "react";
import { relayBridge } from "./relayBridge.js";

type ReadyList = Extract<DeviceListResult, { kind: "ready" }>;

/** The owner's override while the 7-day bound pauses this Mac's bank fetch (null: not offered). */
export type KeepFetchingState = {
  /** The other Mac's name from the device list; null when the list cannot name it. */
  readonly otherMac: string | null;
  readonly confirming: boolean;
  readonly busy: boolean;
  readonly failed: boolean;
  onAsk(): void;
  onCancel(): void;
  onConfirm(): void;
} | null;

/**
 * "Keep fetching on this Mac": offered only while the host reports this Mac, the pinned fetch leader,
 * paused by the offline bound (`leader.paused`; the host checks it again before it records the
 * acknowledgement). Done, the host pushes the device list without the pause. DevicesScreen remounts
 * this hook per vault.
 */
export function useKeepFetching(list: ReadyList | null): KeepFetchingState {
  const vault = useProfile();
  const connection = useConnection();
  const bridge = relayBridge();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    const ref = epoch;
    return () => {
      ref.current++;
    };
  }, []);
  const online = connection === "online" || connection === "recovered";
  if (!bridge || !online || list?.leader.paused !== "offline_too_long") return null;
  const peer = list.leader.pausedPeer;
  const otherMac =
    peer === undefined ? null : (list.devices.find((device) => device.id === peer)?.name ?? null);

  async function confirm(): Promise<void> {
    if (!bridge || busy) return;
    const ticket = epoch.current;
    setConfirming(false);
    setBusy(true);
    setFailed(false);
    try {
      const result = await bridge.keepFetching({ vault });
      if (epoch.current === ticket) setFailed(result.kind !== "done");
    } catch {
      if (epoch.current === ticket) setFailed(true);
    } finally {
      if (epoch.current === ticket) setBusy(false);
    }
  }

  return {
    otherMac,
    confirming,
    busy,
    failed,
    onAsk: () => setConfirming(true),
    onCancel: () => setConfirming(false),
    onConfirm: () => void confirm(),
  };
}
