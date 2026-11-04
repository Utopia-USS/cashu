import {
  type InstrumentSearchResult,
  type ReadySignals,
  type SignalsWatchTarget,
  signalsRemoveWatch,
  signalsSearch,
  signalsWatch,
} from "@cashu/store/investments/signals-screen";
import { useUiAction } from "@cashu/store-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SignalsFeedbackApi } from "./useSignalsFeedback.js";
import { type WatchItem, watchHit, watchRow } from "./watchModels.js";

const SEARCH_DEBOUNCE_MS = 250;

/** The Watchlist page: instrument search (debounced, local and remote hits), add, remove and undo. */
export function useWatchlistPage(args: {
  readonly data: ReadySignals | null;
  readonly privacy: boolean;
  readonly feedback: SignalsFeedbackApi;
  readonly onOpenAsset?: (gid: string) => void;
}) {
  const { data, privacy, feedback } = args;
  const [text, setText] = useState("");
  const [result, setResult] = useState<InstrumentSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [removed, setRemoved] = useState<WatchItem | null>(null);
  const searchAction = useUiAction(signalsSearch);
  const watchAction = useUiAction(signalsWatch);
  const removeAction = useUiAction(signalsRemoveWatch);
  const changeText = (value: string) => {
    setResult(null);
    setSearching(false);
    setText(value);
  };
  const searchRun = useRef(searchAction.run);
  useLayoutEffect(() => {
    searchRun.current = searchAction.run;
  }, [searchAction.run]);
  useEffect(() => {
    if (!text.trim() || privacy) return;
    let live = true;
    const timer = setTimeout(() => {
      setSearching(true);
      void searchRun
        .current({ query: text })
        .then((outcome) => {
          if (live && outcome.status === "completed" && outcome.value.query === text.trim())
            setResult(outcome.value);
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, privacy]);
  const current = privacy || result?.query !== text.trim() ? null : result;
  const hits = current === null ? [] : [...current.local, ...current.remote];

  const add = async (
    target: SignalsWatchTarget,
    note?: string | null,
    tags?: readonly string[] | null,
  ): Promise<boolean> => {
    if (privacy) return false;
    const saved = await feedback.exclusive("watch add", async () => {
      const outcome = await watchAction.run({
        target,
        ...(note === undefined ? {} : { note }),
        ...(tags === undefined ? {} : { tags }),
      });
      if (outcome.status === "completed" && outcome.value.ok) {
        changeText("");
        feedback.setNotice(
          outcome.value.value.cacheStatus === "unconfirmed"
            ? "cache"
            : outcome.value.value.warnings.length
              ? "watch_warning"
              : "saved",
        );
        return true;
      }
      if (outcome.status === "outcome_unknown") feedback.setNotice("unknown");
      else {
        feedback.setRefusal(
          outcome.status !== "completed"
            ? outcome.reason
            : outcome.value.ok
              ? "unexpected_result"
              : outcome.value.reason,
        );
        feedback.setNotice("failed");
      }
      return false;
    });
    return saved ?? false;
  };
  const remove = (instrument: string) => {
    const item = data?.watchlist.find((row) => row.instrument === instrument);
    if (!item || privacy) return;
    void feedback.exclusive("watch remove", async () => {
      const outcome = await removeAction.run({ item: item.gid });
      if (outcome.status === "completed") {
        setRemoved(item);
        feedback.setNotice("removed");
      } else if (outcome.status === "outcome_unknown") feedback.setNotice("unknown");
      else {
        feedback.setRefusal(outcome.reason);
        feedback.setNotice("failed");
      }
    });
  };
  const choose = (key: string) => {
    const hit = hits.find((row) => row.key === key);
    if (!hit) return;
    if (hit.state === "new") {
      if (hit.yahoo_symbol)
        void add({
          kind: "pick",
          yahooSymbol: hit.yahoo_symbol,
          ticker: hit.symbol,
          name: hit.name,
          assetClass: hit.asset_class,
          mic: hit.mic,
          isin: hit.isin,
        });
      else void add({ kind: "text", text: hit.symbol });
    } else if (hit.instrument_id && hit.state === "watched") args.onOpenAsset?.(hit.instrument_id);
    else if (hit.instrument_id) void add({ kind: "instrument", gid: hit.instrument_id });
  };
  return {
    /** The valuation context (quotes) is unavailable: the list cannot be shown. */
    available: data?.context.status === "ready",
    rows: data?.context.status === "ready" ? data.context.watchlist.map(watchRow) : [],
    search: {
      text,
      hits: hits.map(watchHit),
      searching,
      remoteUnavailable: current?.remote_status === "unavailable",
      /** No hit matches the typed text: offer to add it as a free-text symbol. */
      offerTyped: text.trim() !== "" && hits.length === 0,
    },
    canRestore: removed !== null,
    onSearch: changeText,
    onChoose: choose,
    onAddTyped: () => {
      void add({ kind: "text", text: text.trim() });
    },
    onRemove: remove,
    onRestore: async () => {
      if (removed === null) return;
      const saved = await add(
        { kind: "instrument", gid: removed.instrument },
        removed.note,
        removed.tags,
      );
      if (saved) setRemoved(null);
    },
    onOpenAsset: (instrument: string) => args.onOpenAsset?.(instrument),
  };
}
export type WatchlistPageState = ReturnType<typeof useWatchlistPage>;
