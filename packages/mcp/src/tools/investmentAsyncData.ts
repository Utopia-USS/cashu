/** Allowlisted public quote DTOs: no class instance or provider-owned bar survives an await. */
import { D, parseDateTime, toCurrency, toStorage } from "@cashu/domain";
import { asInstrumentId, priceBar } from "@cashu/domain/investments";
import type { WatchQuote } from "@cashu/store/investments/services";
import { type NativeAsyncValue, ownedValue } from "../runtime/async.js";

export function object(raw: NativeAsyncValue): Readonly<Record<string, NativeAsyncValue>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || raw instanceof Uint8Array)
    throw new Error("invalid async record");
  return raw as Readonly<Record<string, NativeAsyncValue>>;
}
export function text(raw: NativeAsyncValue | undefined): string {
  if (typeof raw !== "string") throw new Error("invalid async string");
  return raw;
}
const nullable = (raw: NativeAsyncValue | undefined): string | null =>
  raw === null ? null : text(raw);
export function quoteDto(quote: WatchQuote | null): NativeAsyncValue {
  if (quote === null) return null;
  return ownedValue({
    symbol: quote.symbol,
    currency: quote.currency,
    instrumentType: quote.instrumentType,
    longName: quote.longName,
    bars: quote.bars.map((b) => ({
      instrumentId: b.instrumentId,
      date: b.date,
      close: b.close.toString(),
      source: b.source,
      fetchedAt: b.fetchedAt === null ? null : toStorage(b.fetchedAt),
      open: b.open?.toString() ?? null,
      high: b.high?.toString() ?? null,
      low: b.low?.toString() ?? null,
      volume: b.volume,
      currency: b.currency,
    })),
  });
}
export function quoteFromDto(raw: NativeAsyncValue): WatchQuote | null {
  if (raw === null) return null;
  const quote = object(raw);
  if (!Array.isArray(quote.bars)) throw new Error("invalid async bars");
  return {
    symbol: text(quote.symbol),
    currency: toCurrency(text(quote.currency)),
    instrumentType: nullable(quote.instrumentType),
    longName: nullable(quote.longName),
    bars: quote.bars.map((rawBar) => {
      const b = object(rawBar);
      if (b.volume !== null && (typeof b.volume !== "number" || !Number.isFinite(b.volume)))
        throw new Error("invalid async bar volume");
      const decimal = (v: NativeAsyncValue | undefined) => (v === null ? null : D(text(v)));
      return priceBar({
        instrumentId: asInstrumentId(text(b.instrumentId)),
        date: text(b.date),
        close: D(text(b.close)),
        source: text(b.source),
        fetchedAt: b.fetchedAt === null ? null : parseDateTime(text(b.fetchedAt)),
        open: decimal(b.open),
        high: decimal(b.high),
        low: decimal(b.low),
        volume: b.volume as number | null,
        currency: b.currency === null ? null : toCurrency(text(b.currency)),
      });
    }),
  };
}
