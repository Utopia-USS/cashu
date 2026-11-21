// Settings > Devices, designer spec devices-v1 (variant 1). The lab's states: Q normal, L a phone removed
// its own copy, B changes still pending from a device, P bank fetch paused, S sync off, R the removal
// dialog, F the "fetch on this Mac" dialog, A pair a phone; plus the dialogs' error states. Synthetic
// data only: profile "Anna", devices "Demo Mac", "Studio Mac", "iPhone 16 Pro", "Old iPhone".
import type { DeviceListResult, RevokePreviewResult } from "@cashu/host-protocol";
import { ToastProvider, useToast } from "@cashu/ui";
import { type ReactNode, useEffect, useRef } from "react";
import type { PairingViewState } from "../pairing/PairingView.js";
import { T } from "./Devices.strings.js";
import { DevicesView } from "./DevicesView.js";
import { deviceRows } from "./deviceRows.js";
import { type SyncRowState, SyncRowView } from "./SyncRowView.js";
import type { DevicesScreenState } from "./useDevicesScreen.js";
import type { KeepFetchingState } from "./useKeepFetching.js";
import type { LeaderActionState } from "./useLeaderAction.js";

type Ready = Extract<DeviceListResult, { kind: "ready" }>;
type Prepared = Extract<RevokePreviewResult, { kind: "prepared" }>;

const noop = () => {};
const asyncNoop = async () => {};
const TODAY = "2026-11-21";
const DEMO = "b".repeat(32);
const STUDIO = "c".repeat(32);
const PHONE = "d".repeat(32);
const OLD = "e".repeat(32);
const FETCHED = new Date(2026, 10, 21, 7, 31).getTime();
const SYNCED = new Date(2026, 10, 21, 10, 12).getTime();

const device = (id: string, name: string, offset: number, pairedOn: string) => ({
  id,
  name,
  trusted: true,
  revoked: false,
  behind: false,
  forked: false,
  forkAgreed: null,
  pairedBy: DEMO,
  pairedAt: { seg: 1, offset },
  pairedOn,
});

const list: Ready = {
  kind: "ready",
  vault: "a".repeat(32),
  ownDevice: DEMO,
  operations: [],
  leaderOperations: [],
  evidence: {
    historyPending: false,
    overflow: false,
    authorityUncertain: false,
    writeAdmission: "ready",
  },
  leader: {
    mode: "pinned",
    state: "ok",
    device: DEMO,
    pendingFrom: null,
    lastActivityAt: FETCHED,
    silentForMs: 3 * 60 * 60 * 1000,
    warn: false,
  },
  keyProvenance: { source: "own", sender: DEMO, recipientsKnown: true },
  devices: [
    device(DEMO, "Demo Mac", 0, "2026-11-02"),
    device(STUDIO, "Studio Mac", 4, "2026-11-04"),
    device(PHONE, "iPhone 16 Pro", 9, "2026-11-14"),
  ],
};
const withOld: Ready = {
  ...list,
  devices: [
    ...list.devices,
    { ...device(OLD, "Old iPhone", 6, "2026-11-09"), leftAt: "2026-11-15" },
  ],
};
const behind: Ready = {
  ...list,
  devices: list.devices.map((row) => (row.id === PHONE ? { ...row, behind: true } : row)),
};
const paused: Ready = {
  ...list,
  leader: { ...list.leader, paused: "offline_too_long", pausedPeer: STUDIO },
};
/** Studio Mac fetches and has been silent for three days: the 36-hour rule allows the change. */
const silent: Ready = {
  ...list,
  leader: {
    ...list.leader,
    state: "silent",
    device: STUDIO,
    lastActivityAt: FETCHED - 3 * 86_400_000,
    silentForMs: 3 * 86_400_000,
    warn: true,
  },
};

const screen = (overrides: Partial<DevicesScreenState> = {}): DevicesScreenState => ({
  list,
  stale: false,
  profileName: "Anna",
  dialogOpen: false,
  target: "",
  targetName: null,
  blocked: null,
  openRemoval: noop,
  closeRemoval: asyncNoop,
  preview: null,
  recertify: [],
  toggleRecertify: noop,
  selectionDirty: false,
  refusal: null,
  ackKind: "plain",
  ack: false,
  setAck: noop,
  phrase: "",
  setPhrase: noop,
  status: "idle",
  operationId: null,
  review: asyncNoop,
  commit: asyncNoop,
  inspect: asyncNoop,
  ...overrides,
});
const leader = (overrides: Partial<LeaderActionState> = {}): LeaderActionState => ({
  list,
  available: true,
  dialogOpen: false,
  target: "",
  targetName: null,
  current: null,
  force: false,
  setForce: noop,
  status: "idle",
  operationId: null,
  blocked: false,
  open: noop,
  confirm: asyncNoop,
  inspect: asyncNoop,
  close: noop,
  ...overrides,
});
const sync = (enabled: boolean): SyncRowState => ({
  kind: "ready",
  enabled,
  line: enabled ? { kind: "synced", at: SYNCED, day: "today" } : { kind: "off" },
  busy: false,
  outcome: "none",
  confirmingPurge: false,
  onToggle: noop,
  onReconnect: noop,
  onTryNow: noop,
  onAskPurge: noop,
  onCancelPurge: noop,
  onPurge: noop,
});
const pairingIdle: PairingViewState = { kind: "idle", onCreate: asyncNoop };
const prepared = (overrides: Partial<Prepared> = {}): Prepared => ({
  kind: "prepared",
  vault: list.vault,
  token: "f".repeat(32),
  operationId: "0".repeat(26),
  expiresAt: Date.now() + 300_000,
  targets: [{ device: PHONE, cut: { seg: 1, offset: 9 }, head: "trusted" }],
  affected: [],
  warning: "unseen_writes_possible",
  localStartConfirmationRequired: false,
  ...overrides,
});
const keepFetching: NonNullable<KeepFetchingState> = {
  otherMac: "Studio Mac",
  confirming: false,
  busy: false,
  failed: false,
  onAsk: noop,
  onCancel: noop,
  onConfirm: noop,
};

function page({
  state = screen(),
  leaderAction = leader(),
  syncOn = true,
  fetchPaused = null,
  keep = null,
  pairing = pairingIdle,
}: {
  state?: DevicesScreenState;
  leaderAction?: LeaderActionState;
  syncOn?: boolean;
  fetchPaused?: "outage" | "sync_off" | null;
  keep?: KeepFetchingState;
  pairing?: PairingViewState;
}): ReactNode {
  const ready = state.list?.kind === "ready" ? state.list : null;
  return (
    <DevicesView
      state={state}
      rows={
        ready === null
          ? []
          : deviceRows(ready, TODAY, ready.leader.warn && !fetchPaused && leaderAction.available)
      }
      leaderAction={leaderAction}
      fetchPaused={fetchPaused}
      keepFetching={keep}
      onGoToSync={noop}
      syncRow={<SyncRowView state={sync(syncOn)} />}
      pairing={pairing}
    />
  );
}

/** The removal dialog for the iPhone, with `overrides` on top. */
const removal = (overrides: Partial<DevicesScreenState> = {}) =>
  screen({
    dialogOpen: true,
    target: PHONE,
    targetName: "iPhone 16 Pro",
    preview: prepared(),
    ...overrides,
  });

export default { title: "Desktop/Settings/Devices", component: DevicesView };

/** Q: normal. */
export const Normal = { render: () => page({}) };
/** L: a phone removed its own copy: greyed, the note offers the removal. */
export const RemovedItsCopy = {
  render: () => page({ state: screen({ list: withOld }), leaderAction: leader({ list: withOld }) }),
};
/** B: changes from the phone have not reached this Mac yet. */
export const PendingChanges = {
  render: () => page({ state: screen({ list: behind }), leaderAction: leader({ list: behind }) }),
};
/** A device whose history does not match this Mac's. */
export const ConflictingHistory = {
  render: () => {
    const forked: Ready = {
      ...list,
      devices: list.devices.map((row) =>
        row.id === STUDIO ? { ...row, forked: true, forkAgreed: { seg: 1, offset: 2 } } : row,
      ),
    };
    return page({ state: screen({ list: forked }), leaderAction: leader({ list: forked }) });
  },
};
/** P: this Mac's bank fetch is paused by the 7-day bound while sync is on. */
export const FetchPaused = {
  render: () =>
    page({
      state: screen({ list: paused }),
      leaderAction: leader({ list: paused }),
      fetchPaused: "outage",
      keep: keepFetching,
    }),
};
/** P with sync switched off (two Macs). */
export const FetchPausedSyncOff = {
  render: () =>
    page({
      state: screen({ list: paused }),
      leaderAction: leader({ list: paused }),
      syncOn: false,
      fetchPaused: "sync_off",
      keep: keepFetching,
    }),
};
/** P: the banner's "Keep fetching on this Mac" opens dialog F with the override's wording. */
export const KeepFetchingConfirm = {
  render: () =>
    page({
      state: screen({ list: paused }),
      leaderAction: leader({ list: paused }),
      fetchPaused: "outage",
      keep: { ...keepFetching, confirming: true },
    }),
};
/** The same when the device list cannot name the other Mac. */
export const KeepFetchingConfirmUnnamed = {
  render: () =>
    page({
      state: screen({ list: paused }),
      leaderAction: leader({ list: paused }),
      fetchPaused: "sync_off",
      keep: { ...keepFetching, otherMac: null, confirming: true },
    }),
};
/** S: sync off. */
export const SyncOff = { render: () => page({ syncOn: false }) };
/** Studio Mac silent for 3 days: this Mac's row menu offers "Fetch bank data on this Mac". */
export const FetcherSilent = {
  render: () => page({ state: screen({ list: silent }), leaderAction: leader({ list: silent }) }),
};
/** R: the removal dialog, the plain checkbox. */
export const Remove = { render: () => page({ state: removal() }) };
/** R with changes pending from the phone. */
export const RemovePendingChanges = {
  render: () => page({ state: removal({ list: behind, ackKind: "behind" }) }),
};
/** R when this Mac has nothing from the phone yet (local start). */
export const RemoveLocalStart = {
  render: () =>
    page({
      state: removal({
        ackKind: "local_start",
        preview: prepared({
          targets: [{ device: PHONE, cut: { seg: 1, offset: 9 }, head: "local_start" }],
          localStartConfirmationRequired: true,
        }),
      }),
    }),
};
/** R for a device that added others: they stay by default; ready to remove. */
export const RemoveWithAddedDevices = {
  render: () =>
    page({
      state: removal({
        target: STUDIO,
        targetName: "Studio Mac",
        preview: prepared({
          targets: [{ device: STUDIO, cut: { seg: 1, offset: 4 }, head: "trusted" }],
          affected: [{ device: PHONE, name: "iPhone 16 Pro", selected: true }],
        }),
        recertify: [PHONE],
        ack: true,
        phrase: "synthetic words",
      }),
    }),
};
/** R after unticking a device: the selection has to be reviewed again. */
export const RemoveSelectionChanged = {
  render: () =>
    page({
      state: removal({
        target: STUDIO,
        targetName: "Studio Mac",
        preview: prepared({
          affected: [{ device: PHONE, name: "iPhone 16 Pro", selected: true }],
        }),
        selectionDirty: true,
      }),
    }),
};
/** R: cashU cannot keep every ticked device (the iPhone is ticked). */
export const RemoveCapacity = {
  render: () =>
    page({
      state: removal({
        target: STUDIO,
        targetName: "Studio Mac",
        preview: prepared({
          targets: [{ device: STUDIO, cut: { seg: 1, offset: 4 }, head: "trusted" }],
          affected: [{ device: PHONE, name: "iPhone 16 Pro", selected: true }],
        }),
        recertify: [PHONE],
        refusal: "recertify_capacity",
      }),
    }),
};
/** R: the device history is still being checked. */
export const RemoveHistoryPending = {
  render: () => page({ state: removal({ preview: null, blocked: "pending" }) }),
};
/** R: the device history needs a repair. */
export const RemoveHistoryOverflow = {
  render: () => page({ state: removal({ preview: null, blocked: "overflow" }) }),
};
/** R: writes on this Mac are paused. */
export const RemoveWriterPaused = {
  render: () => page({ state: removal({ preview: null, blocked: "writer" }) }),
};
/** R: the host refused or the removal could not finish. */
export const RemoveFailed = {
  render: () => page({ state: removal({ preview: null, status: "failed" }) }),
};
/** R: working. */
export const RemoveBusy = {
  render: () => page({ state: removal({ preview: null, status: "busy" }) }),
};
/** R: outcome unknown, "Check outcome". */
export const RemoveUnknown = {
  render: () =>
    page({ state: removal({ preview: null, status: "unknown", operationId: "1".repeat(26) }) }),
};
/** An open removal found at start (no device known in this window). */
export const RemoveUnknownUnnamed = {
  render: () =>
    page({
      state: screen({
        dialogOpen: true,
        status: "unknown",
        operationId: "1".repeat(26),
      }),
    }),
};
/** F: fetch on this Mac, Studio Mac silent for 3 days: the force option. */
export const FetchHere = {
  render: () =>
    page({
      state: screen({ list: silent }),
      leaderAction: leader({
        list: silent,
        dialogOpen: true,
        target: DEMO,
        targetName: "Demo Mac",
        current: { name: "Studio Mac", days: 3 },
        force: true,
      }),
    }),
};
/** F when the fetching Mac has been silent for under a day: the force text names no duration. */
export const FetchHereUnderADay = {
  render: () =>
    page({
      leaderAction: leader({
        list: silent,
        dialogOpen: true,
        target: DEMO,
        targetName: "Demo Mac",
        current: { name: "Studio Mac", days: 0 },
      }),
    }),
};
/** F with no device fetching now. */
export const FetchNoFetcher = {
  render: () =>
    page({
      leaderAction: leader({ dialogOpen: true, target: DEMO, targetName: "Demo Mac" }),
    }),
};
/** F while the device history is being checked. */
export const FetchBlocked = {
  render: () =>
    page({
      leaderAction: leader({
        dialogOpen: true,
        target: DEMO,
        targetName: "Demo Mac",
        blocked: true,
      }),
    }),
};
/** F: the change could not finish. */
export const FetchFailed = {
  render: () =>
    page({
      leaderAction: leader({
        dialogOpen: true,
        target: DEMO,
        targetName: "Demo Mac",
        current: { name: "Studio Mac", days: 3 },
        status: "failed",
      }),
    }),
};
/** F: outcome unknown, "Check outcome". */
export const FetchUnknown = {
  render: () =>
    page({
      leaderAction: leader({ dialogOpen: true, status: "unknown", operationId: "2".repeat(26) }),
    }),
};
/** Studio Mac fetched recently: this Mac's row menu shows the fetch item disabled until 36 hours. */
export const FetchItemWaiting = {
  render: () => {
    const studioFetches: Ready = { ...list, leader: { ...list.leader, device: STUDIO } };
    return page({
      state: screen({ list: studioFetches }),
      leaderAction: leader({ list: studioFetches }),
    });
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    canvasElement
      .querySelector<HTMLButtonElement>(`li[data-device="${DEMO}"] button[aria-expanded]`)
      ?.click();
  },
};

/** Shows `text` once as a toast over the page, the way a finished action does. */
function WithToast({ text, children }: { text: string; children: ReactNode }) {
  const toast = useToast();
  // Once: the provider hands out a new `toast` on each of its renders.
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    toast(text, 60_000);
  }, [toast, text]);
  return children;
}
/** The removal finished: the dialog closed and the toast says so. */
export const RemovedToast = {
  render: () => (
    <ToastProvider>
      <WithToast text={T.removed("iPhone 16 Pro")}>{page({})}</WithToast>
    </ToastProvider>
  ),
};
/** The fetching device changed: the toast names this Mac. */
export const FetchDoneToast = {
  render: () => (
    <ToastProvider>
      <WithToast text={T.fetchDone("Demo Mac")}>{page({})}</WithToast>
    </ToastProvider>
  ),
};
/** A: pair a phone (the dialog opens from the header button; this story shows the invitation). */
export const PairPhone = {
  render: () =>
    page({
      pairing: {
        kind: "invited",
        qr: "cashu-pair:synthetic-invitation",
        codePreview: "cashu-pair:k3Jw9…Q2x",
        expiresAt: new Date(2026, 10, 21, 10, 20).getTime(),
        phone: "waiting",
        code: "",
        onCodeChange: noop,
        onConfirm: asyncNoop,
        onCancel: asyncNoop,
        onCopy: noop,
        canCopy: true,
        copied: false,
        submitting: false,
      },
    }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const open = [...canvasElement.querySelectorAll("button")].find(
      (button) => button.textContent === "Pair a phone" || button.textContent === "Połącz telefon",
    );
    open?.click();
  },
};
/** A host handover: the last list stays, actions disabled; the message only after 3 s (CSS). */
export const Reconnecting = { render: () => page({ state: screen({ stale: true }) }) };
/** No list at all for more than 3 s. */
export const Unavailable = { render: () => page({ state: screen({ list: null }) }) };
