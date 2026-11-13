// TRANSITIONAL(S44): Anna's demo portfolio, part of the companion demo build (`companionDemo.ts`). Every
// name, ticker price, rate and amount is SYNTHETIC: two brokerage accounts (IKE at DIF, a regular one at
// XTB), six instruments, 36 monthly PLN 1,000 deposits into the IKE (the bank side sends PLN 1,000 to
// "DOM MAKLERSKI DEMO" on the 11th) on top of opening deposits dated before the bank history, a CD
// Projekt thesis and an alert, a research run with three notes and a candidate, two journal decisions,
// and the leader's daily evaluation run once over the seeded prices, so the alert fires and the
// strategy rules open what they open. Prices are a seeded random walk per instrument pinned to fixed
// end values (CD Projekt ends at PLN 214.60 after a 9.4% fall over 5 sessions); the same series goes
// into the device price cache (`seedCompanionPrices`); the phone's own Yahoo refresh skips the demo
// vaults (`refreshPrices`), so the story holds online too. Runs through the narrow commands entry, plus
// the leader-only demo-commands entry for the daily evaluation.
import { addDays, D, type DateTime, type IsoDate, parseDateTime } from "@cashu/domain";
import { market, toCurrency } from "@cashu/domain/investments";
import { strategyTemplate } from "@cashu/domain/investments/strategy";
// Type only (erased from the bundle): no narrow entry exports the command type.
import type { Command } from "@cashu/store";
import {
  addBrokerageAccount,
  addManualTransaction,
  addResearchNote,
  addToWatchlist,
  classifyInstrument,
  createAlert,
  createInstrument,
  createThesis,
  finishResearchRun,
  recordDecision,
  startResearchRun,
} from "@cashu/store/investments/commands";
import { dailyEvaluation } from "@cashu/store/investments/demo-commands";
import type { SqlPriceCache } from "@cashu/store/investments/local";
import { latestStrategyVersion, strategySnapshot } from "@cashu/store/investments/screen-sources";
import type { Read } from "@cashu/store/query";

type Apply = <I, R>(command: Command<I, R>, input: unknown) => R;
type Step = (time: number, run: () => void) => void;

interface DemoInstrument {
  readonly key: string;
  readonly name: string;
  readonly assetClass: "equity" | "etf" | "treasury_bond";
  readonly currency: "PLN" | "EUR" | "USD";
  readonly mic: string | null;
  /** Yahoo symbol; null = no price source (valued at cost). */
  readonly yahoo: string | null;
  readonly tags: readonly string[];
  /** The walk: the last close, daily drift and volatility. */
  readonly end: number;
  readonly drift: number;
  readonly volatility: number;
}

const INSTRUMENTS: readonly DemoInstrument[] = [
  {
    key: "CDR",
    name: "CD Projekt",
    assetClass: "equity",
    currency: "PLN",
    mic: "XWAR",
    yahoo: "CDR.WA",
    tags: [],
    end: 214.6,
    drift: 0.0002,
    volatility: 0.016,
  },
  {
    key: "VWCE",
    name: "Vanguard FTSE All-World",
    assetClass: "etf",
    currency: "EUR",
    mic: "XETR",
    yahoo: "VWCE.DE",
    tags: ["global_equity"],
    end: 141.2,
    drift: 0.0003,
    volatility: 0.009,
  },
  {
    key: "EDO",
    name: "Obligacje skarbowe EDO",
    assetClass: "treasury_bond",
    currency: "PLN",
    mic: null,
    yahoo: null,
    tags: [],
    end: 100,
    drift: 0,
    volatility: 0,
  },
  {
    key: "DBND",
    name: "Polish Bond ETF",
    assetClass: "etf",
    currency: "PLN",
    mic: "XWAR",
    yahoo: "DBND.WA",
    tags: ["bonds"],
    end: 103.2,
    drift: 0.0001,
    volatility: 0.002,
  },
  {
    key: "VT",
    name: "Vanguard Total World",
    assetClass: "etf",
    currency: "USD",
    mic: "ARCX",
    yahoo: "VT",
    tags: ["global_equity"],
    end: 111.4,
    drift: 0.0003,
    volatility: 0.009,
  },
  {
    key: "BETA",
    name: "Beta ETF S&P 500",
    assetClass: "etf",
    currency: "PLN",
    mic: "XWAR",
    yahoo: "ETFBSPX.WA",
    tags: ["global_equity"],
    end: 312.4,
    drift: 0.0003,
    volatility: 0.01,
  },
];

/** The research candidate (in the vault, so the phone's Watch resolves it; not held, not watched). */
const CANDIDATE = {
  name: "Beta ETF mWIG40TR",
  symbol: "ETFBM40TR",
  yahoo: "ETFBM40TR.WA",
  mic: "XWAR",
} as const;

const FX = [
  { currency: "EUR", end: 4.2386, volatility: 0.002 },
  { currency: "USD", end: 3.662, volatility: 0.003 },
] as const;

/** CD Projekt's close five sessions before the last one: -9.4% to 214.60 over the window. */
const CDR_WINDOW_START = 236.87;

/** mulberry32 (as the bank side of the demo). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const weekday = (iso: IsoDate) => {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};
/** `iso`, or the next weekday after it. */
const weekdayFrom = (iso: IsoDate): IsoDate => (weekday(iso) ? iso : weekdayFrom(addDays(iso, 1)));
/** The most recent Saturday strictly before `today`. */
function lastSaturday(today: IsoDate): IsoDate {
  let day = addDays(today, -1);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 6) day = addDays(day, -1);
  return day;
}
/** The same day `months` months from `iso` (clamped to the month's last day). */
function shiftMonths(iso: IsoDate, months: number): IsoDate {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + months;
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(Number(iso.slice(8, 10)), last);
  return `${first.toISOString().slice(0, 8)}${String(day).padStart(2, "0")}`;
}

interface CompanionMarket {
  /** Weekdays from 10 days before the history to today. */
  readonly days: readonly IsoDate[];
  /** Close per day, keyed by the instrument key. */
  readonly bars: ReadonlyMap<string, ReadonlyMap<IsoDate, number>>;
  readonly rates: ReadonlyMap<string, ReadonlyMap<IsoDate, number>>;
}

/**
 * The demo's daily closes and NBP rates: a seeded gaussian walk per series, scaled so it ends at the
 * series' fixed last value (CD Projekt: the walk ends at 236.87 five sessions before the last day,
 * then falls in equal steps to 214.60). Deterministic for a given `today` and history start.
 */
function companionMarket(today: IsoDate, historyStart: IsoDate): CompanionMarket {
  const rand = prng(0xc0de);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const days: IsoDate[] = [];
  for (let day = addDays(historyStart, -10); day <= today; day = addDays(day, 1))
    if (weekday(day)) days.push(day);
  const walk = (end: number, drift: number, volatility: number, digits: number, tail = 0) => {
    const levels: number[] = [];
    let level = 1;
    for (let i = 0; i < days.length - tail; i++) {
      level *= 1 + drift + volatility * gauss();
      levels.push(level);
    }
    const scale = end / (levels.at(-1) ?? 1);
    return levels.map((l) => Number((l * scale).toFixed(digits)));
  };
  const bars = new Map<string, Map<IsoDate, number>>();
  for (const i of INSTRUMENTS) {
    if (i.yahoo === null) continue;
    let closes: number[];
    if (i.key === "CDR") {
      closes = walk(CDR_WINDOW_START, i.drift, i.volatility, 2, 5);
      const step = (i.end / CDR_WINDOW_START) ** (1 / 5);
      for (let k = 1; k <= 5; k++)
        closes.push(k === 5 ? i.end : Number((CDR_WINDOW_START * step ** k).toFixed(2)));
    } else {
      closes = walk(i.end, i.drift, i.volatility, 2);
    }
    bars.set(i.key, new Map(days.map((d, k) => [d, closes[k] as number])));
  }
  const rates = new Map<string, Map<IsoDate, number>>();
  for (const r of FX) {
    const values = walk(r.end, 0, r.volatility, 4);
    rates.set(r.currency, new Map(days.map((d, k) => [d, values[k] as number])));
  }
  return { days, bars, rates };
}

/** Writes the demo series into a price cache, as the phone's refresh would (Yahoo bars, NBP rates). */
function writeCompanionMarket(
  cache: market.PriceCache,
  series: CompanionMarket,
  now: DateTime,
): void {
  for (const i of INSTRUMENTS) {
    const closes = i.yahoo === null ? undefined : series.bars.get(i.key);
    if (i.yahoo === null || closes === undefined) continue;
    cache.upsertBars(
      market.marketSymbol("yahoo", i.yahoo),
      [...closes].map(([date, close]) => ({
        date,
        close: D(close.toFixed(2)),
        open: null,
        high: null,
        low: null,
        volume: null,
        currency: toCurrency(i.currency),
        fetchedAt: null,
      })),
      now,
    );
  }
  for (const [currency, rates] of series.rates)
    cache.upsertRates(
      "nbp",
      toCurrency(currency),
      [...rates].map(([date, rate]) => ({ date, rate: D(rate.toFixed(4)), fetchedAt: null })),
      now,
    );
}

/**
 * The demo prices into this device's cache, after Anna's vault was built on this launch (a rebuilt
 * vault comes with its prices; upserts of the same series are idempotent).
 */
export function seedCompanionPrices(
  prices: SqlPriceCache,
  today: IsoDate,
  historyStart: IsoDate,
): void {
  const series = companionMarket(today, historyStart);
  prices.batch(() => writeCompanionMarket(prices, series, parseDateTime(`${today}T06:30:00Z`)));
}

/** The passive starter with a weekly review and the PLN 2,500 monthly plan. */
export function companionStrategy(): { yaml: string; markdown: string } {
  const template = strategyTemplate("passive_etf");
  if (template === null) throw new Error("companion demo: the passive strategy template is absent");
  const from = "  monthly_amount: 1000\n";
  if (!template.yaml.includes(from) || !template.yaml.includes("proxy: VWCE.DE"))
    throw new Error("companion demo: the passive strategy template changed");
  const yaml = `${template.yaml.replace(from, "  monthly_amount: 2500\n").trimEnd()}

# How often you review the portfolio (weekly, on the digest weekday).
review:
  every: week
`;
  return { yaml, markdown: template.markdown };
}

const CDR_NOTE = [
  "Third-quarter revenue came in close to expectations; the back catalogue carried the quarter, as it has since 2024. The company repeated its plan for the next major release but stopped short of naming a quarter.",
  "Your thesis is wrong if the 2027 release slips again. Not yet: one industry report suggests a delay, the company has not confirmed it.",
  "What changed since the last note: bookings guidance unchanged. Two analysts cut their targets after the call, and the shares fell 6% over the two sessions that followed.",
  "What to watch: the Q4 call on 26 November and any update on the release window.",
].join("\n\n");

const source = (path: string, publisher: string, title: string, day: IsoDate) => ({
  url: `https://research.example.com/${path}`,
  publisher,
  title,
  published_at: day,
});

/**
 * Plans Anna's portfolio as build steps (`step(time, run)`; the build runs them in time order with
 * its wall clock at each step's time). `at(day, hour, minute)` is a local wall time (ms).
 */
export function planAnnaInvestments(deps: {
  readonly today: IsoDate;
  /** The first day of the bank history (36 months back). */
  readonly historyStart: IsoDate;
  readonly apply: Apply;
  readonly step: Step;
  readonly at: (day: IsoDate, hour: number, minute?: number) => number;
  readonly read: Read;
}): void {
  const { today, historyStart, apply, step, at, read } = deps;
  const series = companionMarket(today, historyStart);
  const close = (key: string, day: IsoDate) => {
    const value = series.bars.get(key)?.get(day);
    if (value === undefined) throw new Error(`companion demo: no ${key} close on ${day}`);
    return value;
  };
  const rate = (currency: string, day: IsoDate) => {
    const value = series.rates.get(currency)?.get(day);
    if (value === undefined) throw new Error(`companion demo: no ${currency} rate on ${day}`);
    return value;
  };
  const gids = new Map<string, string>();
  const accounts = { ike: "", brokerage: "" };
  const gid = (key: string) => {
    const value = gids.get(key);
    if (value === undefined) throw new Error(`companion demo: no instrument ${key}`);
    return value;
  };
  const opening = weekdayFrom(addDays(historyStart, -7));
  const buy = (account: string, key: string, day: IsoDate, quantity: number, price?: number) => {
    const i = INSTRUMENTS.find((x) => x.key === key) as DemoInstrument;
    apply(addManualTransaction, {
      account,
      instrument: gid(key),
      type: "buy",
      tradeDate: day,
      quantity: String(quantity),
      price: (price ?? close(key, day)).toFixed(2),
      currency: i.currency,
      ...(i.currency === "PLN"
        ? {}
        : { cashCurrency: "PLN", fxRate: rate(i.currency, day).toFixed(4) }),
    });
  };
  const deposit = (account: string, day: IsoDate, amount: number) =>
    apply(addManualTransaction, {
      account,
      type: "deposit",
      tradeDate: day,
      cashAmount: String(amount),
      currency: "PLN",
    });
  const plnPrice = (key: string, day: IsoDate) => {
    const i = INSTRUMENTS.find((x) => x.key === key) as DemoInstrument;
    return close(key, day) * (i.currency === "PLN" ? 1 : rate(i.currency, day));
  };
  const units = (key: string, day: IsoDate, budget: number) =>
    Math.max(1, Math.floor(budget / plnPrice(key, day)));

  // Accounts, instruments and the IKE's opening deposit, a week before the bank history starts.
  step(at(opening, 9), () => {
    accounts.ike = apply(addBrokerageAccount, {
      name: "IKE",
      broker: "dif",
      wrapper: "ike",
    }).account;
    accounts.brokerage = apply(addBrokerageAccount, { name: "Brokerage", broker: "xtb" }).account;
    for (const i of INSTRUMENTS) {
      const created = apply(createInstrument, {
        name: i.name,
        symbol: i.key,
        mic: i.mic,
        assetClass: i.assetClass,
        currency: i.currency,
        tags: [...i.tags],
        aliases: i.yahoo === null ? [] : [{ namespace: "yahoo", value: i.yahoo, guessed: false }],
      });
      // A trade names an instrument the vault references; the watchlist is that reference.
      apply(addToWatchlist, { target: { stored: created.gid } });
      gids.set(i.key, created.gid);
    }
    // The candidate: known to the vault through its classification (not held, not watched).
    const candidate = apply(createInstrument, {
      name: CANDIDATE.name,
      symbol: CANDIDATE.symbol,
      mic: CANDIDATE.mic,
      assetClass: "etf",
      currency: "PLN",
      aliases: [{ namespace: "yahoo", value: CANDIDATE.yahoo, guessed: false }],
    }).gid;
    apply(classifyInstrument, { instrument: candidate, region: "PL" });
    gids.set(CANDIDATE.symbol, candidate);
    deposit(accounts.ike, opening, 56_000);
    buy(accounts.ike, "VWCE", opening, units("VWCE", opening, 36_000));
    buy(accounts.ike, "BETA", opening, units("BETA", opening, 11_000));
    buy(accounts.ike, "DBND", opening, units("DBND", opening, 7_000));
  });

  // PLN 1,000 into the IKE on the 10th (the next weekday), split VWCE / BETA / DBND.
  for (let month = 0; month < 36; month++) {
    const day = weekdayFrom(`${shiftMonths(historyStart, month).slice(0, 8)}10`);
    if (day > today) continue;
    step(at(day, 10), () => {
      deposit(accounts.ike, day, 1_000);
      buy(accounts.ike, "VWCE", day, units("VWCE", day, 560));
      buy(accounts.ike, "BETA", day, units("BETA", day, 250));
      buy(accounts.ike, "DBND", day, units("DBND", day, 120));
    });
  }

  // The regular account: one deposit, then EDO, CD Projekt (with its thesis) and VT.
  const brokerageDay = weekdayFrom(shiftMonths(today, -15));
  const edoDay = weekdayFrom(addDays(brokerageDay, 7));
  const cdrDay = weekdayFrom(shiftMonths(today, -14));
  const vtDay = weekdayFrom(shiftMonths(today, -8));
  step(at(brokerageDay, 11), () => deposit(accounts.brokerage, brokerageDay, 33_000));
  step(at(edoDay, 11), () => buy(accounts.brokerage, "EDO", edoDay, 100, 100));
  step(at(cdrDay, 11), () => {
    buy(accounts.brokerage, "CDR", cdrDay, 45, 245.5);
    apply(createThesis, {
      instrument: gid("CDR"),
      entryType: "trend",
      thesis: "a full release pipeline through 2028 at a fair price",
      invalidation: "the 2027 release slips again",
      sizePlan: "at most 8%, buy more only below PLN 205",
    });
  });
  step(at(vtDay, 16), () => buy(accounts.brokerage, "VT", vtDay, 20));

  // The alert on a % move (the store's change_pct kind), set two months ago.
  const alertDay = shiftMonths(today, -2);
  step(at(alertDay, 20), () =>
    apply(createAlert, {
      kind: "change_pct",
      title: "CDR -8% in 5 sessions",
      params: { window_days: 5, threshold: 0.08, direction: "down" },
      instrument: gid("CDR"),
      severity: "action",
      polarity: "negative",
    }),
  );

  // Saturday's research run: three notes and a candidate.
  const saturday = lastSaturday(today);
  const friday = addDays(saturday, -1);
  const thursday = addDays(saturday, -2);
  step(at(saturday, 9), () => {
    const { run } = apply(startResearchRun, {
      scope: { held: true, watchlist: true, candidates: true },
    });
    apply(addResearchNote, {
      run,
      instrument: gid("CDR"),
      lang: "en",
      note: {
        kind: "news",
        polarity: "negative",
        strength: 2,
        thesis_relation: "weakens",
        thesis_field: "invalidation",
        title: "Q3 and the 2027 slate",
        summary: CDR_NOTE,
        sources: [
          source(
            "cdr/q3-report",
            "Company report",
            "Company Q3 report and call transcript",
            thursday,
          ),
          source("cdr/release-window", "Industry news site", "Release window report", friday),
          source("cdr/quotes", "Exchange", "Exchange quote history", saturday),
          source("cdr/broker-note", "Broker", "Public broker note summary", friday),
        ],
      },
    });
    apply(addResearchNote, {
      run,
      instrument: null,
      lang: "en",
      note: {
        kind: "news",
        polarity: "positive",
        strength: 1,
        thesis_relation: "none",
        theme: "polish_bonds",
        title: "Polish bonds after the rate cut",
        summary:
          "The rate cut lifted Polish bond prices across the curve. Inflation-linked retail bonds reset their coupon on the next anniversary, so the effect on EDO comes later.",
        sources: [
          source("bonds/rate-cut", "Central bank", "Monetary policy statement", thursday),
          source("bonds/curve", "Bond market data", "Treasury curve after the decision", friday),
        ],
      },
    });
    apply(addResearchNote, {
      run,
      instrument: null,
      lang: "en",
      note: {
        kind: "macro",
        polarity: "neutral",
        strength: 1,
        thesis_relation: "none",
        theme: "usd_pln",
        title: "USD/PLN: what moved it this month",
        summary:
          "The dollar lost ground against the zloty this month as the rate gap narrowed. Holdings priced in dollars are worth less in zloty even when their own price is flat.",
        sources: [source("fx/usdpln", "Central bank", "Table A mid rates", friday)],
      },
    });
    apply(addResearchNote, {
      run,
      instrument: gid(CANDIDATE.symbol),
      lang: "en",
      note: {
        kind: "candidate",
        polarity: "positive",
        strength: 1,
        thesis_relation: "none",
        title: "Beta ETF mWIG40TR: Polish mid caps",
        summary:
          "A Warsaw-listed ETF on the mWIG40 total return index. It would add Polish mid caps, which the portfolio holds only through CD Projekt.",
        candidate: {
          symbol_or_isin: CANDIDATE.yahoo,
          name: CANDIDATE.name,
          exchange: "GPW",
          currency: "PLN",
        },
        details: {
          entry_type: "trend",
          criteria: [
            { text: "a low-cost index ETF listed in Warsaw", met: true },
            { text: "adds a market the portfolio does not hold", met: true },
          ],
        },
        sources: [source("mwig40/factsheet", "Fund issuer", "Fund factsheet", friday)],
      },
    });
    apply(finishResearchRun, { run, lang: "en" });
  });

  // Two journal entries.
  const tenDaysAgo = addDays(today, -10);
  const twoDaysAgo = addDays(today, -2);
  step(at(tenDaysAgo, 19), () =>
    apply(recordDecision, { action: "held", instrument: gid("DBND"), reason: "monthly plan" }),
  );
  step(at(twoDaysAgo, 19), () =>
    apply(recordDecision, { action: "bought", instrument: gid("BETA"), reason: "monthly plan" }),
  );

  // Last step of the build: the leader's daily evaluation over the seeded prices.
  step(at(today, 6, 45), () => {
    const prices = new market.InMemoryPriceCache();
    writeCompanionMarket(prices, series, parseDateTime(`${today}T06:30:00Z`));
    const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
    const latest = latestStrategyVersion(read);
    if (vault === undefined || latest === undefined)
      throw new Error("companion demo: no profile or strategy for the daily evaluation");
    const snapshot = strategySnapshot(read, {
      vault,
      generation: "fixture",
      revision: latest.gid,
      files: { yaml: latest.yamlText, md: latest.mdText, readError: null },
    });
    if (snapshot.status !== "current")
      throw new Error(`companion demo: strategy ${snapshot.reason}`);
    apply(dailyEvaluation({ strategy: snapshot.state, market: { prices }, lang: "en" }), {
      asOf: today,
      trigger: "demo",
    });
  });
}
