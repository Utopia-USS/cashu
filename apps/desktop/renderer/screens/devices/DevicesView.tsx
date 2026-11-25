import { Button, Dialog, KeyValues } from "@cashu/ui";
import { type ReactNode, useState } from "react";
import { T as P } from "../pairing/Pairing.strings.js";
import { PairingView, type PairingViewState } from "../pairing/PairingView.js";
import { DeviceRowItem } from "./DeviceRowItem.js";
import { T } from "./Devices.strings.js";
import type { DeviceRow } from "./deviceRows.js";
import { FetchDialog } from "./FetchDialog.js";
import { FetchPausedBanner } from "./FetchPausedBanner.js";
import { RemoveDeviceDialog } from "./RemoveDeviceDialog.js";
import { S } from "./Sync.strings.js";
import type { DevicesScreenState } from "./useDevicesScreen.js";
import type { KeepFetchingState } from "./useKeepFetching.js";
import type { LeaderActionState } from "./useLeaderAction.js";

/** Pairing states that start a new invitation when "Pair a phone" opens the dialog. */
const STARTS = new Set([
  "idle",
  "completed",
  "refused",
  "already_added",
  "phone_cancelled",
  "expired",
]);

/**
 * Settings > Devices (designer spec devices-v1, variant 1): the title, the Sync card, one list with a
 * row per device (facts, row menu, notes), the closed security details and the dialogs.
 */
export function DevicesView({
  state,
  rows,
  leaderAction,
  fetchPaused = null,
  keepFetching = null,
  onGoToSync,
  syncRow,
  pairing,
}: {
  state: DevicesScreenState;
  /** The list's rows (`deviceRows`), this Mac first. */
  rows: readonly DeviceRow[];
  leaderAction: LeaderActionState;
  /** Bank fetches paused by the 7-day offline bound (`fetchPausedLine`): which text to show. */
  fetchPaused?: "outage" | "sync_off" | null;
  /** The owner's override while paused: this Mac is the one that fetches. */
  keepFetching?: KeepFetchingState;
  /** Moves focus to the Sync row (absent: no Sync row). */
  onGoToSync?: () => void;
  /** The Sync card, between the lead line and the device list. */
  syncRow?: ReactNode;
  /** The phone pairing flow behind "Pair a phone" (absent: no pairing on this screen, e.g. no sync config). */
  pairing?: PairingViewState;
}) {
  const [pairOpen, setPairOpen] = useState(false);
  // Rendered only once the list has been missing for the reconnect window (`state.unavailable`): a host
  // handover after a pairing or a sync switch never shows it, not even to a screen reader.
  const unavailable = state.unavailable && <p>{T.unavailable}</p>;
  // The Settings card carries the title ("Devices"); the page starts with the lead line.
  const header = (
    <p className="text-fg-secondary">
      {state.profileName === null ? T.leadUnnamed : T.lead(state.profileName)}
    </p>
  );
  function openPairing(): void {
    setPairOpen(true);
    if (pairing && "onCreate" in pairing && STARTS.has(pairing.kind)) void pairing.onCreate();
  }
  function closePairing(): void {
    setPairOpen(false);
    if (pairing?.kind === "invited") void pairing.onCancel();
  }
  const pairButton = pairing && (
    <div className="ml-auto flex gap-2">
      <Button variant="primary" onPress={openPairing}>
        {P.title}
      </Button>
    </div>
  );
  const pairDialog = pairOpen && pairing && (
    <Dialog size="narrow" title={P.title} label={P.title} onClose={closePairing}>
      <PairingView
        bare
        state={pairing}
        onDone={closePairing}
        {...(onGoToSync
          ? {
              onGoToSync: () => {
                setPairOpen(false);
                onGoToSync();
              },
            }
          : {})}
      />
    </Dialog>
  );
  // Without a list, pairing still works: the section keeps its button (no count to show).
  if (state.list?.kind !== "ready")
    return (
      <div className="grid gap-6">
        {header}
        {syncRow}
        <section className="grid gap-2.5" aria-label={T.section}>
          {pairButton && <div className="flex flex-wrap items-center gap-2.5">{pairButton}</div>}
          {unavailable}
        </section>
        {pairDialog}
      </div>
    );
  const list = state.list;
  const { stale } = state;
  const busy = state.status === "busy" || leaderAction.status === "busy";
  const sender =
    list.keyProvenance.sender === null
      ? undefined
      : list.devices.find((device) => device.id === list.keyProvenance.sender)?.name;
  const keyOrigin =
    list.keyProvenance.source === "own"
      ? T.keyOwn
      : list.keyProvenance.source === "wrap"
        ? sender === undefined
          ? T.keyWrapUnnamed
          : T.keyWrap(sender)
        : list.keyProvenance.source === "pairing"
          ? T.keyPairing
          : T.keyUnknown;
  return (
    <div className="grid gap-6">
      {header}
      {syncRow}
      {unavailable}
      <section className="grid gap-2.5" aria-labelledby="devices-list-title">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* The card already says "Devices": the header counts them (designer DV2 item 2). */}
          <h3 id="devices-list-title" className="font-strong">
            {T.count(rows.length)}
          </h3>
          {pairButton}
        </div>
        {fetchPaused && (
          <FetchPausedBanner
            fetchPaused={fetchPaused}
            keepFetching={keepFetching}
            secondary={onGoToSync ? { label: S.goToSync, onPress: onGoToSync } : null}
          />
        )}
        <ul className="rounded-lg border border-border bg-surface">
          {rows.map((row) => (
            <DeviceRowItem
              key={row.id}
              row={row}
              disabled={stale || busy || !!state.preview}
              onFetch={leaderAction.open}
              onRemove={state.openRemoval}
            />
          ))}
        </ul>
      </section>
      <details>
        <summary className="cursor-pointer text-fg-secondary">{T.security}</summary>
        <div className="mt-2.5 rounded-lg border border-border bg-surface px-4.5 py-3">
          <KeyValues
            rows={[
              { key: "key", label: T.profileKey, value: keyOrigin },
              { key: "removing", label: T.removing, value: T.removingFact },
            ]}
          />
        </div>
      </details>
      {state.dialogOpen && <RemoveDeviceDialog state={state} />}
      {leaderAction.dialogOpen && <FetchDialog state={leaderAction} />}
      {pairDialog}
    </div>
  );
}
