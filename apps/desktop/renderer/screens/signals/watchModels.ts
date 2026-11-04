/** Watchlist view models: rows with quotes and trend, and search hits. */
import { D, type Decimal, Money } from "@cashu/domain";
import type { InstrumentSearchResult, ReadySignals } from "@cashu/store/investments/signals-screen";
import { investmentMarks } from "../investments/presentation.js";
import type { ValueDisplay } from "./alertModels.js";

export type WatchItem = ReadySignals["watchlist"][number];
type ReadyContext = Extract<ReadySignals["context"], { status: "ready" }>;
type WatchContextRow = ReadyContext["watchlist"][number];
type InstrumentSearchHit = InstrumentSearchResult["local"][number];

export interface WatchRow {
  readonly id: string;
  readonly instrumentId: string;
  readonly label: string;
  readonly held: boolean;
  readonly fromAgent: boolean;
  readonly note: string | null;
  readonly tags: readonly string[];
  readonly marks: readonly string[];
  readonly quote: {
    readonly close: ValueDisplay;
    readonly date: string;
    readonly stale: boolean;
    readonly changeDay: Decimal | null;
    readonly changeMonth: Decimal | null;
  } | null;
  readonly spark: number[] | null;
  readonly liveAlerts: number;
}

const decimalOrNull = (value: number | null): Decimal | null =>
  value === null ? null : D(String(value));

export function watchRow(row: WatchContextRow): WatchRow {
  const quoteCurrency = row.price?.currency || row.instrument?.currency || null;
  const spark = row.closes_30d.map((point) => Number(String(point.close)));
  const close = row.price === null ? null : D(String(row.price.close));
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    label: row.instrument?.symbol ?? row.instrument?.name ?? row.instrument_id,
    held: row.held,
    fromAgent: row.source === "agent",
    note: row.note || null,
    tags: row.tags,
    marks: investmentMarks(row.instrument ?? {}, row.hints, row.held),
    quote:
      row.price === null || close === null
        ? null
        : {
            close: quoteCurrency
              ? { kind: "money", value: new Money(close, quoteCurrency) }
              : { kind: "amount", value: close },
            date: row.price.date,
            stale: row.price.stale,
            changeDay: decimalOrNull(row.price.change_1d),
            changeMonth: decimalOrNull(row.price.change_1m),
          },
    spark: spark.length > 1 && spark.every(Number.isFinite) ? spark : null,
    liveAlerts: row.alerts.live,
  };
}

export interface WatchHit {
  readonly key: string;
  readonly symbol: string;
  readonly name: string;
  readonly state: InstrumentSearchHit["state"];
  /** A watched hit opens its instrument; any other hit is added. */
  readonly opens: boolean;
}

export const watchHit = (hit: InstrumentSearchHit): WatchHit => ({
  key: hit.key,
  symbol: hit.symbol,
  name: hit.name,
  state: hit.state,
  opens: hit.state === "watched",
});
