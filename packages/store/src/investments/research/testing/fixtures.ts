// Test fixtures for the research services (the Python `invp_support` investor: a brokerage account
// holding ABC, WRLD and XMPL from a canonical import). Synthetic data only.
import { addDays, D, parseDateTime } from "@cashu/domain";
import { market } from "@cashu/domain/investments";
import { expect } from "vitest";
import type { CommandOutcome } from "../../../command.js";
import { createThesis } from "../../commands/journal.js";
import {
  applyRaw,
  brokerage,
  raw,
  stock,
  type Vault,
  vault,
} from "../../commands/testing/fixtures.js";
import { type SignalView, signalByGid } from "../../queries/signals.js";
import { type AddedNote, addResearchNote } from "../commands.js";

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export const DAY = 24 * HOUR;
/** The fixture clock's day (testEnv: 2026-10-31T12:00Z, a Saturday of ISO week 2026-W44). */
export const TODAY = "2026-10-31";

export interface Investor {
  readonly v: Vault;
  readonly account: string;
  readonly abc: string;
  readonly wrld: string;
  readonly xmpl: string;
  readonly read: Vault["store"]["read"];
}

let hashSeq = 0;
const hash = () => (++hashSeq).toString(16).padStart(64, "0");

/** A transaction of the canonical import (Python `invp_support.ROWS`). */
function txn(
  v: Vault,
  account: string,
  instrument: string | null,
  data: Record<string, unknown>,
): { type: string; gid: string; data: Record<string, unknown> } {
  const dedupHash = hash();
  return {
    type: "invTxn.imported",
    gid: v.det("inv_transactions", [account, dedupHash]),
    data: {
      account,
      batch: null,
      type: "buy",
      tradeDate: "2026-01-07",
      settleDate: null,
      instrument,
      quantity: null,
      price: null,
      currency: "PLN",
      grossAmount: "0",
      fee: "0",
      tax: "0",
      cashAmount: "0",
      cashCurrency: "PLN",
      fxRate: null,
      splitRatio: null,
      note: null,
      source: "import",
      externalRef: null,
      dedupHash,
      createdAt: "2026-01-07T09:00:00.000001Z",
      ...data,
    },
  };
}

/** Python `investor` fixture: a profile holding ABC, WRLD and XMPL. */
export function investor(): Investor {
  const v = vault();
  const account = brokerage(v);
  const abc = stock(v, "ABC", "PLABC0000016", {
    name: "ABC Example SA",
    aliases: [yahoo("ABC.WA")],
  });
  const wrld = stock(v, "WRLD", "IE00BEXAMPL1", {
    name: "World Equity UCITS ETF",
    currency: "EUR",
    assetClass: "etf",
    mic: "XETR",
    aliases: [yahoo("WRLD.DE")],
  });
  const xmpl = stock(v, "XMPL", "US0000000001", {
    name: "Example Corp",
    currency: "USD",
    mic: "XNAS",
    aliases: [yahoo("XMPL")],
  });
  applyRaw(v, [
    txn(v, account, null, {
      type: "deposit",
      tradeDate: "2026-01-05",
      grossAmount: "20000.00",
      cashAmount: "20000.00",
    }),
    txn(v, account, abc, {
      quantity: "100",
      price: "50.00",
      grossAmount: "5000.00",
      fee: "5.00",
      cashAmount: "-5005.00",
    }),
    txn(v, account, wrld, {
      tradeDate: "2026-01-12",
      quantity: "10",
      price: "100.00",
      currency: "EUR",
      grossAmount: "1000.00",
      cashAmount: "-4300.00",
      fxRate: "4.3",
    }),
    txn(v, account, xmpl, {
      tradeDate: "2026-01-14",
      quantity: "20",
      price: "100.00",
      currency: "USD",
      grossAmount: "2000.00",
      cashAmount: "-8000.00",
      fxRate: "4.0",
    }),
  ]);
  return { v, account, abc, wrld, xmpl, read: v.store.read.bind(v.store) };
}

/** A Yahoo price alias (the price cache keys bars by provider symbol). */
export const yahoo = (value: string) => ({ namespace: "yahoo", value, guessed: false });

const FETCHED_AT = parseDateTime("2026-10-31T06:00:00Z");

/** Daily closes of `symbol` (Yahoo) for the `days` up to `end`, from `close(day)`. */
export function putBars(
  cache: market.PriceCache,
  symbol: string,
  end: string,
  days: number,
  close: (day: string) => string,
  currency: string,
): void {
  const bars = Array.from({ length: days + 1 }, (_, i) => {
    const date = addDays(end, i - days);
    return {
      date,
      close: D(close(date)),
      open: null,
      high: null,
      low: null,
      volume: null,
      currency: currency as never,
      fetchedAt: FETCHED_AT,
    };
  });
  cache.upsertBars(market.marketSymbol("yahoo", symbol), bars, FETCHED_AT);
}

/** NBP rates (PLN per unit) of `quote` for the given days. */
export function putRates(
  cache: market.PriceCache,
  quote: string,
  days: readonly string[],
  rate: (day: string) => string,
): void {
  cache.upsertRates(
    "nbp",
    quote as never,
    days.map((date) => ({ date, rate: D(rate(date)), fetchedAt: FETCHED_AT })),
    FETCHED_AT,
  );
}

/** Python `distinct_words`: three words unique to `n` (synthetic notes are never near duplicates). */
export function distinctWords(n: number): string {
  let code = "";
  let value = n;
  for (let i = 0; i < 4; i++) {
    code += String.fromCharCode(97 + (value % 26));
    value = Math.floor(value / 26);
  }
  return `a${code} b${code} c${code}`;
}

/** Python `raw`: a valid note body numbered `n`. */
function rawNote(
  n: number,
  changes: Record<string, unknown> = {},
  url = `https://example.com/news/${n}`,
): Record<string, unknown> {
  return {
    kind: "news",
    polarity: "negative",
    strength: 2,
    title: `Example fact number ${n} ${distinctWords(n)}`,
    summary: `Przykladowy fakt ${distinctWords(n)} ze zrodla, opisany neutralnie.`,
    sources: [{ url, publisher: "Example News", published_at: TODAY }],
    ...changes,
  };
}

export interface AddOptions {
  /** An instrument reference (symbol, ISIN, gid); null for a theme / segment / candidate note. */
  readonly instrument?: string | null;
  readonly run?: string | null;
  readonly createdBy?: "agent" | "user";
  readonly url?: string;
}

/** Python `add`: store note `n` through the command (the outcome, refused or not). */
export function addNote(
  v: Vault,
  n: number,
  changes: Record<string, unknown> = {},
  o: AddOptions = {},
): CommandOutcome<AddedNote> {
  return v.run(addResearchNote, {
    note: rawNote(n, changes, o.url),
    instrument: o.instrument === undefined ? "XMPL" : o.instrument,
    run: o.run ?? null,
    createdBy: o.createdBy ?? "agent",
  });
}

/** `addNote` that must succeed. */
export function added(
  v: Vault,
  n: number,
  changes: Record<string, unknown> = {},
  o: AddOptions = {},
): AddedNote {
  const out = addNote(v, n, changes, o);
  if (!out.ok) expect.fail(`addResearchNote refused: ${out.reason}`);
  return out.value;
}

/** The refusal code of a command outcome (fails the test when it succeeded). */
export function refusal<R>(out: CommandOutcome<R>): string {
  if (out.ok) expect.fail("expected a refusal");
  return out.reason;
}

/** Python `thesis`: a trend thesis on `instrument`. */
export function thesis(v: Vault, instrument: string, text = "Example thesis"): string {
  return v.value(createThesis, { instrument, entryType: "trend", thesis: text }).thesis;
}

/** Python `watch`: put `instrument` on the watchlist. */
export function watch(v: Vault, instrument: string, note?: string): void {
  applyRaw(v, [raw.watchAdded(v, instrument, note === undefined ? {} : { note })]);
}

/** Python `signals`: the vault's research signals in fold order. */
export function researchSignals(v: Vault): SignalView[] {
  const read = v.store.read.bind(v.store);
  return read<{ gid: string }>(
    "SELECT gid FROM inv_signals WHERE dedup_key LIKE 'research:%' ORDER BY id",
  ).map((r) => signalByGid(read, r.gid) as SignalView);
}
