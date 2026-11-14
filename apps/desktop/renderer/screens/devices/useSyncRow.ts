import {
  deviceListResultSchema,
  type RelayActionResult,
  type RelayStatusResult,
} from "@cashu/host-protocol";
import { deviceListState } from "@cashu/store/core/desktop-settings";
import { useConnection, useProfile, useQuery } from "@cashu/store-react";
import { useEffect, useRef, useState } from "react";
import { relayBridge } from "./relayBridge.js";
import type { SyncRowState } from "./SyncRowView.js";
import { syncStatusLine } from "./syncStatusLine.js";

type Outcome = "none" | "failed" | "purge_done" | "purge_retry" | "reconnect_unavailable";

/**
 * Settings > Devices > Sync. The relay status is a host request, not a live query: it is read when the
 * screen opens, again whenever the live device list is pushed (after every sync pass and device
 * change: the same live query useDevicesScreen reads) and after each owner action. The line shows
 * clock times (today, yesterday, a date), judged at that read: no timer loop, the renderer never polls. DevicesScreen remounts this hook
 * per vault.
 */
export function useSyncRow(): {
  readonly state: SyncRowState;
  readonly status: RelayStatusResult | null;
} {
  const vault = useProfile();
  const connection = useConnection();
  const bridge = relayBridge();
  // A trigger (a new snapshot means the host checked the vault again, structurally shared) and the
  // names the status lines use for the device ids the host sends.
  const changed = useQuery(deviceListState, { privacy: false });
  const parsed = changed.status === "ready" ? deviceListResultSchema.safeParse(changed.list) : null;
  const names =
    parsed?.success && parsed.data.kind === "ready"
      ? new Map(parsed.data.devices.map((device) => [device.id, device.name]))
      : new Map<string, string>();
  const online = connection === "online" || connection === "recovered";
  const [status, setStatus] = useState<RelayStatusResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("none");
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const epoch = useRef(0);

  async function readStatus(): Promise<void> {
    if (!bridge || !online) return;
    const ticket = epoch.current;
    try {
      const next = await bridge.status({ vault });
      if (epoch.current !== ticket) return;
      setStatus(next);
      setNow(Date.now());
    } catch {
      // The host is away (restart, update): the next push or action reads it again.
    }
  }

  useEffect(() => {
    const ticket = ++epoch.current;
    const ref = epoch;
    if (bridge && (connection === "online" || connection === "recovered"))
      bridge.status({ vault }).then(
        (next) => {
          if (ref.current !== ticket) return;
          setStatus(next);
          setNow(Date.now());
        },
        () => {},
      );
    return () => {
      if (ref.current === ticket) ref.current++;
    };
  }, [vault, bridge, connection, changed]);

  async function act(
    run: (input: { vault: string }) => Promise<RelayActionResult>,
    onDone: Outcome,
    onRefused: (reason: Extract<RelayActionResult, { kind: "refused" }>["reason"]) => Outcome,
  ): Promise<void> {
    if (!bridge || !online || busy) return;
    const ticket = epoch.current;
    setBusy(true);
    setOutcome("none");
    try {
      const result = await run({ vault });
      if (epoch.current !== ticket) return;
      setOutcome(result.kind === "done" ? onDone : onRefused(result.reason));
    } catch {
      if (epoch.current === ticket) setOutcome("failed");
    } finally {
      if (epoch.current === ticket) setBusy(false);
      await readStatus();
    }
  }

  if (!bridge || !online || status === null || !status.configured)
    return { state: { kind: "hidden" }, status: online ? status : null };
  return {
    status,
    state: {
      kind: "ready",
      enabled: status.enabled,
      line: syncStatusLine(status, now, (device) => names.get(device) ?? null),
      busy,
      outcome,
      confirmingPurge,
      onToggle: (on) =>
        void act(
          (input) => (on ? bridge.enable(input) : bridge.disable(input)),
          "none",
          () => "failed",
        ),
      onTryNow: () =>
        void act(
          (input) => bridge.syncNow(input),
          "none",
          () => "failed",
        ),
      onReconnect: () =>
        void act(
          (input) => bridge.reconnect(input),
          "none",
          (reason) => (reason === "no_recovery_secret" ? "reconnect_unavailable" : "failed"),
        ),
      onAskPurge: () => setConfirmingPurge(true),
      onCancelPurge: () => setConfirmingPurge(false),
      onPurge: () => {
        setConfirmingPurge(false);
        void act(
          (input) => bridge.purge(input),
          "purge_done",
          (reason) => (reason === "retry" ? "purge_retry" : "failed"),
        );
      },
    },
  };
}
