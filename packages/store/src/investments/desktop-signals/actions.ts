import type { InstrumentSearchResult } from "../services/instrumentSearch.js";

export type { InstrumentSearchResult } from "../services/instrumentSearch.js";

import type { UiAction } from "../../ui-actions.js";
import type { WatchAddOutcome, WatchWarning } from "../services/watchlist.js";

/** The renderer describes only an intent; resolution and source are host-owned. */
export type SignalsWatchTarget =
  | { readonly kind: "instrument"; readonly gid: string }
  | {
      readonly kind: "pick";
      readonly yahooSymbol: string;
      readonly ticker?: string | null;
      readonly name?: string | null;
      readonly assetClass?: string | null;
      readonly mic?: string | null;
      readonly isin?: string | null;
    }
  | { readonly kind: "text"; readonly text: string };

export const signalsSearch: UiAction<{ readonly query: string }, InstrumentSearchResult> = {
  id: "investments.signals.search",
};
export const signalsWatch: UiAction<
  {
    readonly target: SignalsWatchTarget;
    readonly note?: string | null;
    readonly tags?: readonly string[] | null;
  },
  SignalsWatchResult
> = { id: "investments.signals.watch" };
export const signalsRemoveWatch: UiAction<{ readonly item: string }, { readonly item: string }> = {
  id: "investments.signals.removeWatch",
};
export const signalsSnooze: UiAction<
  { readonly signal: string; readonly until: string | null },
  {
    readonly status: "saved" | "saved_cleanup_unconfirmed";
    readonly signal: string;
    readonly dropped: number | null;
  }
> = { id: "investments.signals.snooze" };

export type SignalsWatchResult =
  | Extract<WatchAddOutcome, { readonly ok: false }>
  | {
      readonly ok: true;
      readonly value: Extract<WatchAddOutcome, { readonly ok: true }>["value"] & {
        readonly cacheStatus: "not_applicable" | "published" | "unconfirmed";
      };
    };
export type SignalsWatchWarning = WatchWarning;
