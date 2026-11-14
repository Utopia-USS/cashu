import { type SyncRowState, SyncRowView } from "./SyncRowView.js";
import type { SyncStatusLine } from "./syncStatusLine.js";

const noop = () => {};
/** Synthetic: a fixed 10:12 for the paused and synced lines, 22:40 on 12 Nov for older ones. */
const PAUSED_AT = new Date(2026, 10, 14, 10, 12).getTime();
const EVENING = new Date(2026, 10, 12, 22, 40).getTime();
const today = { kind: "synced", at: PAUSED_AT, day: "today", devices: 3 } as const;
const row = (line: SyncStatusLine, overrides: Partial<SyncRowState & { kind: "ready" }> = {}) => (
  <SyncRowView
    state={{
      kind: "ready",
      enabled: line.kind !== "off",
      line,
      busy: false,
      outcome: "none",
      confirmingPurge: false,
      onToggle: noop,
      onReconnect: noop,
      onTryNow: noop,
      onAskPurge: noop,
      onCancelPurge: noop,
      onPurge: noop,
      ...overrides,
    }}
  />
);

export default { title: "Desktop/Settings/Sync", component: SyncRowView };
export const Synced = { render: () => row(today) };
export const SyncedYesterday = {
  render: () => row({ kind: "synced", at: EVENING, day: "yesterday", devices: 3 }),
};
export const SyncedEarlier = {
  render: () => row({ kind: "synced", at: EVENING, day: "earlier", devices: 3 }),
};
export const FirstSync = { render: () => row({ kind: "first_sync", devices: 1 }) };
export const Off = { render: () => row({ kind: "off" }) };
export const Paused = { render: () => row({ kind: "paused", since: PAUSED_AT }) };
export const Quota = { render: () => row({ kind: "quota" }) };
export const Reconnect = { render: () => row({ kind: "reconnect" }) };
export const ReconnectUnavailable = { render: () => row({ kind: "reconnect_unavailable" }) };
export const StuckWaiting = {
  render: () => row({ kind: "stuck_waiting", device: "Piotr's iPhone" }),
};
export const StuckWaitingUnnamed = { render: () => row({ kind: "stuck_waiting", device: null }) };
export const StuckFailed = {
  render: () => row({ kind: "stuck_failed", device: "Piotr's iPhone" }),
};
export const StuckFailedUnnamed = { render: () => row({ kind: "stuck_failed", device: null }) };
export const RemovalFailing = {
  render: () => row({ kind: "removal_failing", device: "Old iPhone" }),
};
export const RemovalFailingUnnamed = {
  render: () => row({ kind: "removal_failing", device: null }),
};
export const Busy = {
  render: () => row(today, { busy: true }),
};
export const ActionFailed = {
  render: () => row(today, { outcome: "failed" }),
};
export const PurgeConfirm = {
  render: () => row(today, { confirmingPurge: true }),
};
export const PurgeDone = { render: () => row({ kind: "off" }, { outcome: "purge_done" }) };
export const PurgeRetry = { render: () => row({ kind: "off" }, { outcome: "purge_retry" }) };
export const Hidden = { render: () => <SyncRowView state={{ kind: "hidden" }} /> };
