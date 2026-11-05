// AssetList (ab24ab6 v2/Portfolio.tsx:41-176) with the Obserwowane tab (v2/Watchlist.tsx WatchTable `wide`):
// the tabs, split / sort controls, the positions table (InstLabel + RowMarks + classify icon, HintChip, 30-day
// sparkline, price, week, weight bar, value, result, Wynik % with its gain card), per-account rows, the cash row,
// and the watch table. Every text is formatted here; the views lay it out.
import { S as IL } from "@cashu/i18n/investments/v2/InstLabel.strings";
import { S } from "@cashu/i18n/investments/v2/Portfolio.strings";
import { KIND_WORD, S as W } from "@cashu/i18n/investments/v2/Watchlist.strings";
import type {
  CardRow,
  HintChipProps,
  InstCardProps,
  InstTileProps,
  MarksProps,
  SparklineProps,
  Tone,
} from "@cashu/ui";
import {
  accountLabel,
  dm,
  money,
  money0,
  nAccountsInv,
  pct,
} from "@cashu/ui-logic/investments/labels";
import type { AccountRow, Hint } from "@cashu/ui-logic/investments/types";
import {
  alertFact,
  hintChip,
  hintCls,
  hintLine,
  type InstLike,
  instCardFacts,
  instName,
  instSummary,
  planLabel,
  price,
  rowFlags,
  STATE_LABEL,
  subLine,
  watchMove,
  weekChange,
} from "@cashu/ui-logic/investments/v2/logic";
import { S as L } from "@cashu/ui-logic/investments/v2/logic.strings";
import type { PositionV2, WatchItem } from "@cashu/ui-logic/investments/v2/types";
import { gidOf } from "../legacyWire.js";
import type { InvestmentsHomeData } from "../useInvestmentsHomeData.js";
import { type InstState, instStateOf, isHeld, tileOf } from "./instState.js";

export type AssetsTab = "positions" | "watch";
export type AssetSort = "value" | "result" | "week";
type AssetSplit = "total" | "account";

export interface AssetListUi {
  tab: AssetsTab;
  onTab(tab: AssetsTab): void;
  split: AssetSplit;
  onSplit(split: AssetSplit): void;
  sort: AssetSort;
  onSort(sort: AssetSort): void;
  adding: boolean;
  onAdding(adding: boolean): void;
  classify: string | null;
  onClassify(id: string | null): void;
  /** Row click / name button: the instrument's gid. */
  onOpenAsset(gid: string): void;
  onAddTxn(): void;
  /** The watch row's X: the legacy watch id. */
  onUnwatch?(watchId: number): void;
  unwatchBusy?: boolean;
  /** Legacy instrument ids marked read in this window. */
  readIds?: ReadonlySet<string>;
}

/** The instrument label of a row: tile, name, second line, marks, classify icon, hover card / touch title. */
export interface RowLabel {
  tile: Pick<InstTileProps, "monogram" | "plan" | "freshness" | "health" | "faded">;
  name: string;
  sub?: string;
  marks: MarksProps;
  agent: string | null;
  classify: { title: string; label: string; expanded: boolean; onToggle(): void } | null;
  card: InstCardProps;
  /** The one-line title without hover (touch). */
  touchTitle: string;
}

export interface GainCellProps {
  text: string;
  tone: Tone | null;
  /** Hover card rows (gain / loss, cost); null without a gain. */
  rows: CardRow[] | null;
  touchTitle?: string;
}

interface AssetRow {
  key: string;
  onOpen(): void;
  label: RowLabel;
  hint: HintChipProps | null;
  spark: SparklineProps;
  price: string;
  /** Stale price date (`.tag.warn`). */
  priceStale: string | null;
  week: { text: string; tone: Tone };
  weight: { fill: number; text: string };
  value: string;
  result: { text: string; tone: Tone | null };
  gain: GainCellProps;
  parts: {
    key: string;
    account: string;
    weight: { fill: number; text: string };
    value: string;
    gain: GainCellProps;
  }[];
}

interface WatchRow {
  key: number;
  onOpen(): void;
  /** Null when the instrument is unknown (plain name button). */
  label: RowLabel | null;
  name: string;
  recommendation: { text: string; title?: string } | null;
  noRecommendation: string;
  hint: HintChipProps | null;
  spark: SparklineProps;
  price: string | null;
  noPrice: string;
  stale: string | null;
  move: { text: string; tone: Tone; title?: string };
  alerts: { text: string; muted: boolean };
  remove: { title: string; label: string; disabled: boolean; onPress(): void };
}

export interface AssetListProps {
  title: string;
  tabs: {
    label: string;
    items: [string, AssetsTab][];
    value: AssetsTab;
    onChange(tab: AssetsTab): void;
  };
  tab: AssetsTab;
  positions: {
    split: {
      label: string;
      items: [string, AssetSplit][];
      value: AssetSplit;
      onChange(v: AssetSplit): void;
    };
    sort: {
      label: string;
      options: { value: AssetSort; label: string }[];
      value: AssetSort;
      onChange(v: AssetSort): void;
    };
    head: {
      inst: string;
      strategy: string;
      spark: string;
      price: string;
      week: string;
      weight: string;
      value: string;
      result: string;
      resultTitle: string;
      resultPct: string;
    };
    rows: AssetRow[];
    empty: string | null;
    cash: { label: string; weight: { fill: number; text: string }; value: string } | null;
    addTxn: { text: string; onPress(): void };
  };
  watch: {
    add: { text: string; expanded: boolean; onPress(): void };
    /** Null while the watchlist loads (skeleton). */
    rows: WatchRow[] | null;
    empty: string;
    head: {
      inst: string;
      recommendation: string;
      coverage: string;
      spark: string;
      price: string;
      week: string;
      alerts: string;
      actions: string;
    };
    alertsCount: string;
    alertsWord: string;
  };
}

function marksOf(id: number | string, data: InvestmentsHomeData, unread: number): MarksProps {
  const f = rowFlags(id, data.signals, data.alertsQ.data ?? [], unread);
  return {
    flag: f.state ? { state: f.state, label: STATE_LABEL[f.state] } : null,
    alert: f.alert ? alertFact(f.alert) : null,
    notes: f.notes > 0 ? S.newNotes(f.notes) : null,
  };
}

function hintOf(hints: Hint[] | null | undefined, held: boolean): HintChipProps | null {
  const h = (hints ?? []).find((x) => hintChip(x, held) !== "");
  if (!h) return null;
  return {
    code: h.code,
    text: hintChip(h, held),
    title: hintLine(h, held),
    severity: hintCls(h.severity),
  };
}

function cardOf(
  inst: InstLike,
  st: InstState,
  opts: { accounts?: string[]; stale?: string | null; hints?: Hint[] | null },
) {
  const id = String(inst.id);
  const facts = {
    accounts: opts.accounts,
    stale: opts.stale,
    held: isHeld(st, inst.id),
    health: st.health.get(id) ?? null,
    healthStale: st.stale,
    pre: st.pre.has(id),
    hints: opts.hints ?? st.hints.get(id) ?? null,
  };
  const f = instCardFacts(inst, facts);
  const card: InstCardProps = {
    tile: tileOf(inst, st),
    name: f.head[0],
    detail: f.head[1],
    rows: f.rows.map(([key, value, cls]) => ({
      key,
      value,
      tone: cls ? (cls.replace("hv ", "") as CardRow["tone"]) : key === "ISIN" ? "tnum" : undefined,
    })),
    status: f.status.map((text) => ({
      text,
      warn: text !== L.costInterest && text !== L.manualValuation,
    })),
  };
  return { card, touchTitle: instSummary(inst, facts) };
}

function gainOf(
  ratio: number | null,
  gain: number | null,
  cost: number | null,
  c: string,
): GainCellProps {
  const label = gain != null && gain < 0 ? S.loss : S.gain;
  return {
    text: pct(ratio, true),
    tone: ratio == null ? null : ratio >= 0 ? "positive" : "negative",
    rows:
      gain != null
        ? [
            { key: label, value: money(gain, c, true), tone: gain < 0 ? "negative" : "positive" },
            ...(cost != null
              ? [{ key: S.cost, value: money(cost, c), tone: "tnum" as const }]
              : []),
          ]
        : null,
    touchTitle: gain != null ? `${label} ${money(gain, c, true)}` : undefined,
  };
}

/** "1 alert: ponizej 560,00 $" / "2 alerty" / the note / "bez alertu". */
function watchSummary(w: WatchItem): string {
  const n = w.alerts.live;
  const near = w.alerts.nearest;
  const cur = w.price?.currency ?? w.instrument?.currency;
  if (n && near) {
    const what =
      near.level != null
        ? `${(KIND_WORD as Record<string, string | undefined>)[near.kind] ?? near.title} ${price(near.level, cur)}`
        : near.title;
    return `${W.alerts(n)}: ${what}`;
  }
  if (n) return W.alerts(n);
  return w.note ? w.note : W.noAlert;
}

export function assetListProps(data: InvestmentsHomeData, ui: AssetListUi): AssetListProps {
  const positions = data.pos.data as NonNullable<InvestmentsHomeData["pos"]["data"]>;
  const accounts: AccountRow[] = data.ov.data?.accounts ?? [];
  const watch = data.watchQ.data ?? (data.watchQ.error ? [] : null);
  const watchList = watch ?? [];
  const st = instStateOf(data);
  const c = positions.base_currency;
  const open = (id: number | string) => {
    const gid = gidOf(id);
    if (gid) ui.onOpenAsset(gid);
  };
  const unread = (id: number | string): number => {
    if (ui.readIds?.has(String(id))) return 0;
    const p = positions.positions.find((x) => String(x.instrument.id) === String(id));
    const w = watchList.find((x) => String(x.instrument_id) === String(id));
    const summaryN = data.research.summary?.instruments.find(
      (x) => String(x.instrument_id) === String(id),
    )?.unread;
    return p?.research_unread ?? w?.research_unread ?? summaryN ?? 0;
  };
  const accLabel = (id: number) => {
    const a = accounts.find((x) => x.id === id);
    return a ? accountLabel(a, accounts) : S.account(id);
  };

  // ---- positions -----------------------------------------------------------------------------------------
  const key = (p: PositionV2) =>
    ui.sort === "value"
      ? (p.value ?? 0)
      : ui.sort === "result"
        ? (p.unrealized_pct ?? Number.NEGATIVE_INFINITY)
        : (weekChange(p.closes_30d) ?? Number.NEGATIVE_INFINITY);
  const sorted = [...positions.positions].sort((a, b) => key(b) - key(a));
  const cash = positions.cash.reduce((s, x) => s + (x.amount_base ?? 0), 0);
  const cashAccounts = positions.cash.filter((x) => x.amount !== 0).length;
  const maxW = Math.max(
    0.0001,
    ...positions.positions.map((p) => p.weight ?? 0),
    positions.total ? cash / positions.total : 0,
  );
  const weightOf = (w: number | null) => ({
    fill: Math.round(((w ?? 0) / maxW) * 100),
    text: pct(w),
  });
  const rows: AssetRow[] = sorted.map((p) => {
    const id = String(p.instrument.id);
    const i = p.instrument;
    const wk = weekChange(p.closes_30d);
    const cost = p.valuation_mode === "cost";
    const parts = ui.split === "account" && p.accounts.length > 1 ? p.accounts : [];
    const accountNames = p.accounts.map((a) => accLabel(a.account_id));
    const { card, touchTitle } = cardOf(i, st, {
      accounts: accountNames,
      stale: p.is_stale ? p.price_date : null,
      hints: p.hints,
    });
    return {
      key: id,
      onOpen: () => open(i.id),
      label: {
        tile: tileOf(i, st),
        name: instName(i),
        sub: subLine({ cost, split: ui.split, accounts: p.accounts, accLabel }),
        marks: marksOf(id, data, unread(id)),
        agent: null,
        classify: i.needs_classification
          ? {
              title: IL.classifyTitle,
              label: IL.classifyAria(instName(i)),
              expanded: ui.classify === id,
              onToggle: () => ui.onClassify(ui.classify === id ? null : id),
            }
          : null,
        card,
        touchTitle,
      },
      hint: hintOf(p.hints, true),
      spark: {
        values: (p.closes_30d ?? []).map((x) => x.close),
        tone: cost ? "muted" : undefined,
        label: S.spark30d(i.label),
      },
      price: p.price != null ? money(p.price, p.price_currency ?? c) : "-",
      priceStale: p.is_stale ? dm(p.price_date) : null,
      week: {
        text: wk != null ? pct(wk, true) : "-",
        tone: cost || wk == null ? "muted" : wk >= 0 ? "positive" : "negative",
      },
      weight: weightOf(p.weight),
      value: money(p.value, c),
      result: {
        text: money0(p.unrealized, c, true),
        tone: p.unrealized == null ? null : p.unrealized >= 0 ? "positive" : "negative",
      },
      gain: gainOf(p.unrealized_pct, p.unrealized, p.cost, c),
      parts: parts.map((a) => ({
        key: `${id}:${a.account_id}`,
        account: accLabel(a.account_id),
        weight: weightOf(a.weight),
        value: money(a.value, c),
        gain: gainOf(
          a.unrealized_pct,
          a.value != null && a.cost != null ? a.value - a.cost : null,
          a.cost,
          c,
        ),
      })),
    };
  });

  // ---- watchlist (WatchTable wide) ---------------------------------------------------------------------
  const coverage = watchList.filter((w) => planLabel(w.instrument?.plan, false)).length;
  const watchRows: WatchRow[] | null =
    watch === null
      ? null
      : watch.map((w) => {
          const mv = watchMove(w.closes_30d, w.price?.change_1d);
          const daily = mv != null && weekChange(w.closes_30d) == null;
          const name = w.instrument ? instName(w.instrument) : `instrument ${w.instrument_id}`;
          const recommendation = planLabel(w.instrument?.plan, false);
          let label: RowLabel | null = null;
          if (w.instrument) {
            const { card, touchTitle } = cardOf(w.instrument, st, { hints: w.hints });
            label = {
              tile: tileOf(w.instrument, st),
              name,
              sub: w.note ?? undefined,
              marks: marksOf(w.instrument_id, data, unread(w.instrument_id)),
              agent: w.source === "agent" ? "agent" : null,
              classify: null,
              card,
              touchTitle,
            };
          }
          return {
            key: w.id,
            onOpen: () => open(w.instrument_id),
            label,
            name,
            recommendation: recommendation
              ? {
                  text: recommendation,
                  title: w.instrument?.plan_reason ?? undefined,
                }
              : null,
            noRecommendation: W.none,
            hint: hintOf(w.hints, w.held),
            spark: { values: (w.closes_30d ?? []).map((x) => x.close), label: W.spark30d(name) },
            price: w.price ? price(w.price.close, w.price.currency) : null,
            noPrice: W.noPrice,
            stale: w.price?.stale ? W.stale : null,
            move: {
              text: mv ? `${pct(mv.value, true)}${daily ? ` ${W.oneDay}` : ""}` : "-",
              tone: mv == null ? "muted" : mv.value >= 0 ? "positive" : "negative",
              title: daily ? W.oneSessionTitle : undefined,
            },
            alerts: {
              text: w.alerts.live ? watchSummary({ ...w, note: null }) : W.noAlert,
              muted: !w.alerts.live,
            },
            remove: {
              title: W.unwatch,
              label: W.unwatchAria(name),
              disabled: !!ui.unwatchBusy,
              onPress: () => ui.onUnwatch?.(w.id),
            },
          };
        });
  const watchAlerts = watchList.reduce((a, w) => a + w.alerts.live, 0);

  return {
    title: S.assets,
    tabs: {
      label: S.scope,
      items: [
        [S.tabPortfolio(positions.positions.length), "positions"],
        [S.tabWatch(watchList.length), "watch"],
      ],
      value: ui.tab,
      onChange: ui.onTab,
    },
    tab: ui.tab,
    positions: {
      split: {
        label: S.split,
        items: [
          [S.total, "total"],
          [S.perAccount, "account"],
        ],
        value: ui.split,
        onChange: ui.onSplit,
      },
      sort: {
        label: S.sorting,
        options: [
          { value: "result", label: S.sortResult },
          { value: "value", label: S.sortValue },
          { value: "week", label: S.sortWeek },
        ],
        value: ui.sort,
        onChange: ui.onSort,
      },
      head: {
        inst: "Instrument",
        strategy: S.colStrategy,
        spark: S.col30d,
        price: S.colPrice,
        week: S.colWeek,
        weight: S.colWeight,
        value: S.colValue,
        result: S.colResult,
        resultTitle: S.colResultTitle,
        resultPct: S.colResultPct,
      },
      rows,
      empty: rows.length ? null : S.noPositions,
      cash:
        positions.cash.length > 0
          ? {
              label: `${S.cash} · ${nAccountsInv(cashAccounts)}`,
              weight: weightOf(positions.total ? cash / positions.total : null),
              value: money(cash, c),
            }
          : null,
      addTxn: { text: S.addTxn, onPress: ui.onAddTxn },
    },
    watch: {
      add: { text: S.add, expanded: ui.adding, onPress: () => ui.onAdding(!ui.adding) },
      rows: watchRows,
      empty: W.empty,
      head: {
        inst: "Instrument",
        recommendation: W.colRecommendation,
        coverage: `${coverage}/${watchList.length}`,
        spark: W.col30d,
        price: W.colPrice,
        week: W.colWeek,
        alerts: W.colAlerts,
        actions: W.colActions,
      },
      alertsCount: String(watchAlerts),
      alertsWord: S.alertsWord(watchAlerts),
    },
  };
}
