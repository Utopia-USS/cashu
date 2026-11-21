// The mountable watchlist pieces (ab24ab6 v2/Watchlist.tsx, the Home's `watch` sub-route): the search-to-add row
// (Aktywa's Obserwowane tab shows it while `+ Dodaj` is on) and the light grid's standalone widget.

import { S } from "@cashu/i18n/investments/v2/Watchlist.strings";
import { useId, useState } from "react";
import { gidOf } from "../investments/home/legacyWire.js";
import type { InvestmentsHomeData } from "../investments/home/useInvestmentsHomeData.js";
import { instStateOf, tileOf } from "../investments/home/widgets/instState.js";
import { InstrumentSearchView } from "./InstrumentSearchView.js";
import { useInstrumentSearch } from "./useInstrumentSearch.js";
import { useUnwatch } from "./useWatchActions.js";
import { WatchlistWidgetView } from "./WatchlistWidgetView.js";
import { searchProps, watchNarrowRows } from "./watchModel.js";

export { useUnwatch };

interface InstrumentSearchScreenProps {
  /** Esc in the field (old `onAdding(false)`). */
  onClose(): void;
  /** A watched / held hit opens the asset (gid). */
  onOpen(gid: string): void;
}

/** Old InstrumentSearch: the `+ Dodaj` row above the watch list. */
export function InstrumentSearchScreen(props: InstrumentSearchScreenProps) {
  const listId = useId();
  const st = useInstrumentSearch({
    onClose: props.onClose,
    onOpen: (id) => {
      const gid = gidOf(id);
      if (gid !== null) props.onOpen(gid);
    },
  });
  return <InstrumentSearchView {...searchProps(st, listId)} />;
}

export interface WatchlistWidgetScreenProps {
  data: InvestmentsHomeData;
  /** Open the instrument search at once (the `watch` sub-route, the minimal view's "obserwuj instrument"). */
  autoAdd?: boolean;
  onOpen(gid: string): void;
}

/** Old WatchlistWidget (the light grid of a zero-start profile). */
export function WatchlistWidgetScreen(props: WatchlistWidgetScreenProps) {
  const [adding, setAdding] = useState(!!props.autoAdd);
  const items = props.data.watchQ.data ?? (props.data.watchQ.error ? [] : null);
  const list = items ?? [];
  const unwatch = useUnwatch(list);
  const st = instStateOf(props.data);
  const open = (id: number) => {
    const gid = gidOf(id);
    if (gid !== null) props.onOpen(gid);
  };
  const alerts = list.reduce((a, w) => a + w.alerts.live, 0);
  return (
    <WatchlistWidgetView
      count={list.length || null}
      adding={adding}
      onAdd={() => setAdding((v) => !v)}
      search={
        adding ? (
          <InstrumentSearchScreen onClose={() => setAdding(false)} onOpen={props.onOpen} />
        ) : null
      }
      rows={
        items === null
          ? null
          : watchNarrowRows(items, {
              tile: (inst) => tileOf(inst, st),
              busy: unwatch.unwatchBusy,
              onOpen: open,
              onUnwatch: unwatch.onUnwatch,
            })
      }
      alerts={alerts}
      alertsWord={S.alertsWord(alerts)}
    />
  );
}
