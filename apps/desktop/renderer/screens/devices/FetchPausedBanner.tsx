import { Button, Spinner } from "@cashu/ui";
import { T } from "./Devices.strings.js";
import { OFFLINE_BOUND_DAYS } from "./deviceRows.js";
import { KeepFetchingDialog } from "./FetchDialog.js";
import { S } from "./Sync.strings.js";
import type { KeepFetchingState } from "./useKeepFetching.js";

/**
 * The paused bank fetch (7-day offline bound, `fetchPausedLine`), one banner for Settings > Devices and
 * the Banking screen: the same text, the same "Keep fetching on this Mac" override with its dialog F,
 * and a secondary way on that each screen names (Devices: the Sync card; Banking: Devices).
 */
export function FetchPausedBanner({
  fetchPaused,
  keepFetching,
  secondary,
}: {
  readonly fetchPaused: "outage" | "sync_off";
  readonly keepFetching: KeepFetchingState;
  readonly secondary: { readonly label: string; readonly onPress: () => void } | null;
}) {
  return (
    <div role="alert" className="grid gap-2.5 rounded-lg bg-warning-bg p-4 text-warning">
      <p>
        {fetchPaused === "outage" ? T.fetchPausedBanner(OFFLINE_BOUND_DAYS) : S.fetchPausedSyncOff}
      </p>
      <div className="flex flex-wrap gap-2">
        {secondary && <Button onPress={secondary.onPress}>{secondary.label}</Button>}
        {keepFetching && (
          <Button variant="primary" disabled={keepFetching.busy} onPress={keepFetching.onAsk}>
            {T.keepFetching}
          </Button>
        )}
      </div>
      {keepFetching?.busy && (
        <p role="status" className="flex items-center gap-1.5">
          <Spinner />
          {S.working}
        </p>
      )}
      {keepFetching?.failed && <p>{S.actionFailed}</p>}
      {keepFetching?.confirming && <KeepFetchingDialog state={keepFetching} />}
    </div>
  );
}
