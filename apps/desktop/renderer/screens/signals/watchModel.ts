// The pure parts of the ported Watchlist.tsx / InstrumentSearch.tsx (ab24ab6): the row summary (`1 alert: poniżej
// 560,00 $` / the note / `bez alertu`), the light grid widget's narrow rows and the search field's props.
import { S as I } from "@cashu/i18n/investments/v2/InstrumentSearch.strings";
import { KIND_WORD, S } from "@cashu/i18n/investments/v2/Watchlist.strings";
import type { InstTileProps, SparklineProps } from "@cashu/ui";
import { micName, pct } from "@cashu/ui-logic/investments/labels";
import { instName, price, watchMove } from "@cashu/ui-logic/investments/v2/logic";
import { isAddable, optionLabel, typeWord } from "@cashu/ui-logic/investments/v2/searchLogic";
import type { WatchItem } from "@cashu/ui-logic/investments/v2/types";
import type { InstrumentSearchProps } from "./InstrumentSearchView.js";
import type { InstrumentSearchState } from "./useInstrumentSearch.js";

/** "1 alert: poniżej 560,00 $" / "2 alerty" / the note / "bez alertu". */
export function watchSummary(w: WatchItem): string {
  const n = w.alerts.live;
  const near = w.alerts.nearest;
  const cur = w.price?.currency ?? w.instrument?.currency;
  if (n && near) {
    const what =
      near.level != null
        ? `${(KIND_WORD as Record<string, string | undefined>)[near.kind] ?? near.title} ${price(near.level, cur)}`
        : near.title;
    return `${S.alerts(n)}: ${what}`;
  }
  if (n) return S.alerts(n);
  return w.note ? w.note : S.noAlert;
}

export interface WatchNarrowRow {
  key: number;
  tile: Pick<
    InstTileProps,
    "monogram" | "plan" | "strength" | "freshness" | "health" | "faded"
  > | null;
  name: string;
  agent: boolean;
  summary: string;
  spark: SparklineProps;
  price: string | null;
  noPrice: string;
  stale: string | null;
  move: { text: string; tone: "positive" | "negative" | null };
  remove: { title: string; label: string; disabled: boolean; onPress(): void };
  onOpen(): void;
}

/** The light grid widget's rows (old WatchTable narrow: name + summary | spark | price | X). */
export function watchNarrowRows(
  items: WatchItem[],
  o: {
    tile(inst: NonNullable<WatchItem["instrument"]>): WatchNarrowRow["tile"];
    busy: boolean;
    onOpen(instrumentId: number): void;
    onUnwatch(watchId: number): void;
  },
): WatchNarrowRow[] {
  return items.map((w) => {
    const mv = watchMove(w.closes_30d, w.price?.change_1d);
    const wk = mv?.value ?? null;
    const name = w.instrument ? instName(w.instrument) : `instrument ${w.instrument_id}`;
    return {
      key: w.id,
      tile: w.instrument ? o.tile(w.instrument) : null,
      name,
      agent: w.source === "agent",
      summary: watchSummary(w),
      spark: { values: (w.closes_30d ?? []).map((c) => c.close), label: S.spark30d(name) },
      price: w.price ? price(w.price.close, w.price.currency) : null,
      noPrice: S.noPrice,
      stale: w.price?.stale ? S.stale : null,
      move: {
        text: mv ? `${pct(mv.value, true)} ${mv.label}` : "",
        tone: wk == null ? null : wk >= 0 ? "positive" : "negative",
      },
      remove: {
        title: S.unwatch,
        label: S.unwatchAria(name),
        disabled: o.busy,
        onPress: () => o.onUnwatch(w.id),
      },
      onOpen: () => o.onOpen(w.instrument_id),
    };
  });
}

/** The search field's props from its state. */
export function searchProps(st: InstrumentSearchState, listId: string): InstrumentSearchProps {
  const optId = (i: number) => `${listId}-opt-${i}`;
  return {
    inputRef: st.input,
    value: st.text,
    onChange: st.change,
    onKeyDown: st.onKey,
    placeholder: I.placeholder,
    label: I.searchAria,
    listLabel: I.results,
    listId,
    open: st.open,
    activeId: st.open && st.active != null ? optId(st.active) : undefined,
    waiting: st.waiting,
    stale: st.view.stale,
    error: st.err,
    noResults: st.open && st.view.empty ? I.noResults : null,
    unavailable: st.open && st.view.unavailable ? I.onlineUnavailable : null,
    skeleton: st.open && ((st.pending && !st.view.stale) || (st.waiting && !st.rows.length)),
    rows: st.rows.map((row, i) => {
      const base = {
        key: row.key,
        id: optId(i),
        selected: i === st.active,
        busy: st.busy === row.key,
        onMove: () => {
          if (!st.view.stale && st.active !== i) st.setActiveKey(row.key);
        },
        onPress: () => {
          if (!st.view.stale && !st.busy) st.act(row);
        },
      };
      if (row.kind === "free")
        return {
          ...base,
          label: undefined,
          content: { kind: "free" as const, text: I.addFree(row.text) },
        };
      const h = row.hit;
      const ex = h.exchange ?? micName(h.mic);
      return {
        ...base,
        label: optionLabel(h, ex),
        content: {
          kind: "hit" as const,
          symbol: h.symbol,
          name: h.name || null,
          tag:
            h.state === "saved"
              ? { text: I.saved, title: I.savedTitle }
              : h.state === "held"
                ? { text: I.held }
                : null,
          exchange: ex,
          type: typeWord(h),
          mark: isAddable(h) ? ("add" as const) : h.state === "watched" ? ("ok" as const) : null,
        },
      };
    }),
  };
}
