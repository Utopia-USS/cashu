// The watchlist writes of the ported Watchlist.tsx / InstrumentSearch.tsx (ab24ab6): stop watching with an undo
// toast (the undo re-adds the instrument with its note and tags, which restores the same row; an agent's item comes
// back as the owner's), one request at a time.
import { S } from "@cashu/i18n/investments/v2/Watchlist.strings";
import { useToast } from "@cashu/ui";
import { instName } from "@cashu/ui-logic/investments/v2/logic";
import type { WatchItem } from "@cashu/ui-logic/investments/v2/types";
import { useInFlight } from "./legacy/inflight.js";
import { errorText } from "./legacy/outcome.js";
import { offerRecreate } from "./legacy/undoFlow.js";
import { type LegacySignalsApi, useLegacySignalsApi } from "./useLegacySignalsApi.js";

/** Old removeWatchWithUndo: the outcome of the undo is the add's own (409 "Już na liście", 404 "Nie przywrócono"). */
async function removeWatchWithUndo(
  api: LegacySignalsApi,
  w: Pick<WatchItem, "id" | "instrument_id" | "note" | "tags" | "source">,
  label: string,
  toast: ReturnType<typeof useToast>,
): Promise<void> {
  try {
    await api.deleteWatch(w.id);
    offerRecreate(
      toast,
      S.removed(label),
      () =>
        api.postWatch({
          instrument_id: w.instrument_id,
          note: w.note,
          tags: w.tags?.length ? w.tags : null,
        }),
      S.removeWhat,
      () => {},
      errorText,
      10000,
      () => (w.source === "agent" ? S.backAsYours : null),
    );
  } catch (e) {
    toast(S.removeFailed(errorText(e)), 4000);
  }
}

/** The watch row's X (Aktywa's Obserwowane tab, the light grid's widget): `onUnwatch(watchId)` + `unwatchBusy`. */
export function useUnwatch(items: readonly WatchItem[]) {
  const toast = useToast();
  const api = useLegacySignalsApi();
  const flight = useInFlight();
  return {
    unwatchBusy: flight.busy,
    onUnwatch: (watchId: number) => {
      const w = items.find((x) => x.id === watchId);
      if (!w) return;
      void flight.run(() =>
        removeWatchWithUndo(api, w, w.instrument ? instName(w.instrument) : "instrument", toast),
      );
    },
  };
}
