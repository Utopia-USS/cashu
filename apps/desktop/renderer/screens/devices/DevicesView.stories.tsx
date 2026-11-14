import type { DeviceListResult } from "@cashu/host-protocol";
import { DevicesView } from "./DevicesView.js";
import type { DevicesScreenState } from "./useDevicesScreen.js";
import type { LeaderActionState } from "./useLeaderAction.js";

const base = {
  list: {
    kind: "ready",
    vault: "a".repeat(32),
    ownDevice: "b".repeat(32),
    leader: {
      mode: "pinned",
      state: "ok",
      device: "b".repeat(32),
      pendingFrom: null,
      lastActivityAt: Date.now(),
      silentForMs: 0,
      warn: false,
    },
    keyProvenance: { source: "own", sender: "b".repeat(32), recipientsKnown: false },
    operations: [],
    evidence: {
      historyPending: false,
      overflow: false,
      authorityUncertain: false,
      writeAdmission: "ready",
    },
    devices: [
      {
        id: "b".repeat(32),
        name: "This Mac",
        trusted: true,
        revoked: false,
        behind: false,
        forked: false,
        forkAgreed: null,
        pairedBy: "b".repeat(32),
        pairedAt: { seg: 1, offset: 0 },
      },
      {
        id: "c".repeat(32),
        name: "Other device",
        trusted: true,
        revoked: false,
        behind: false,
        forked: false,
        forkAgreed: null,
        pairedBy: "b".repeat(32),
        pairedAt: { seg: 1, offset: 1 },
        // The day the host knows; "This Mac" has none and shows the line without it.
        pairedOn: "2026-11-12",
      },
    ],
  },
  target: "c".repeat(32),
  setTarget: () => {},
  preview: null,
  recertify: [],
  toggleRecertify: () => {},
  selectionDirty: false,
  warningAck: false,
  setWarningAck: () => {},
  localAck: false,
  setLocalAck: () => {},
  phrase: "",
  setPhrase: () => {},
  status: "idle",
  refusal: null,
  operationId: null,
  review: async () => {},
  commit: async () => {},
  inspect: async () => {},
  cancel: async () => {},
} as unknown as DevicesScreenState;

export default { title: "Desktop/Settings/Devices", component: DevicesView };
export const List = { render: () => <DevicesView state={base} leaderAction={leaderAction} /> };
export const Warning = {
  render: () => (
    <DevicesView
      leaderAction={leaderAction}
      state={
        {
          ...base,
          preview: {
            kind: "prepared",
            vault: "a".repeat(32),
            token: "d".repeat(32),
            operationId: "0".repeat(26),
            expiresAt: Date.now() + 60_000,
            targets: [{ device: "c".repeat(32), cut: { seg: 1, offset: 0 }, head: "local_start" }],
            affected: [
              { device: "b".repeat(32), name: "This Mac", selected: false },
              { device: "e".repeat(32), name: "Sibling tablet", selected: false },
            ],
            warning: "unseen_writes_possible",
            localStartConfirmationRequired: true,
          },
        } as DevicesScreenState
      }
    />
  ),
};
export const Unknown = {
  render: () => (
    <DevicesView
      leaderAction={leaderAction}
      state={{ ...base, status: "unknown", operationId: "0".repeat(26) } as DevicesScreenState}
    />
  ),
};
const baseReady = base.list as Extract<DeviceListResult, { kind: "ready" }>;
const leaderList = {
  ...baseReady,
  leader: { ...baseReady.leader, state: "silent" as const, warn: true },
  leaderOperations: [],
};
const leaderAction = {
  list: leaderList,
  available: true,
  target: "",
  setTarget: () => {},
  force: false,
  setForce: () => {},
  preview: null,
  typed: "",
  setTyped: () => {},
  status: "idle",
  operationId: null,
  blocked: false,
  expired: false,
  review: async () => {},
  commit: async () => {},
  inspect: async () => {},
  cancel: () => {},
} as LeaderActionState;
export const LeaderWarning = {
  render: () => (
    <DevicesView
      state={{ ...base, list: leaderList } as DevicesScreenState}
      leaderAction={leaderAction}
    />
  ),
};
const pausedList = {
  ...baseReady,
  leader: { ...baseReady.leader, paused: "offline_too_long" as const },
  leaderOperations: [],
};
const keepFetching = {
  otherMac: "Mac mini",
  confirming: false,
  busy: false,
  failed: false,
  onAsk: () => {},
  onCancel: () => {},
  onConfirm: () => {},
};
/** The 7-day offline bound refuses this Mac while sync is on (designer addendum 2026-11-14). */
export const FetchPaused = {
  render: () => (
    <DevicesView
      state={{ ...base, list: pausedList } as DevicesScreenState}
      leaderAction={{ ...leaderAction, list: pausedList }}
      fetchPaused="outage"
      onGoToSync={() => {}}
      keepFetching={keepFetching}
    />
  ),
};
/** The same with sync switched off (two Macs). */
export const FetchPausedSyncOff = {
  render: () => (
    <DevicesView
      state={{ ...base, list: pausedList } as DevicesScreenState}
      leaderAction={{ ...leaderAction, list: pausedList }}
      fetchPaused="sync_off"
      onGoToSync={() => {}}
      keepFetching={keepFetching}
    />
  ),
};
/** The owner's override asks first (W3-7 item 2). */
export const KeepFetchingConfirm = {
  render: () => (
    <DevicesView
      state={{ ...base, list: pausedList } as DevicesScreenState}
      leaderAction={{ ...leaderAction, list: pausedList }}
      fetchPaused="outage"
      keepFetching={{ ...keepFetching, confirming: true }}
      onGoToSync={() => {}}
    />
  ),
};
/** The same when the device list cannot name the other Mac. */
export const KeepFetchingConfirmUnnamed = {
  render: () => (
    <DevicesView
      state={{ ...base, list: pausedList } as DevicesScreenState}
      leaderAction={{ ...leaderAction, list: pausedList }}
      fetchPaused="sync_off"
      keepFetching={{ ...keepFetching, otherMac: null, confirming: true }}
    />
  ),
};
