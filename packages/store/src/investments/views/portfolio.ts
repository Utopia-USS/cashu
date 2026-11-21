/** Canonical vault-scoped loader. Reuses the established portfolio and price-cache pipelines. */
import { addDays, type IsoDate } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import {
  type AccountId,
  allocate,
  asAccountId,
  buildSnapshot,
  compareChronological,
  fxCurrenciesFor,
  InMemoryFxLookup,
  type Instrument,
  type InstrumentId,
  type ManualValuation,
  marketView,
  type ProfileId,
  preloadRates,
  toCurrency,
  valuePortfolio,
  type views,
} from "@cashu/domain/investments";
import { DEFAULT_DATA_QUALITY } from "@cashu/domain/investments/rules";
import { accountByMemberGid, profileOf, type Read } from "../../core/queries.js";
import { type MarketInput, resolveMarketInput } from "../marketInput.js";
import { watchlist } from "../queries/alerts.js";
import { loadInstruments, vaultInstrumentGids } from "../queries/instruments.js";
import { instrumentGid } from "../queries/shared.js";
import { openSignals } from "../queries/signals.js";
import { manualValuations, renames, transactions } from "../queries/transactions.js";
import type { StrategyState } from "../services/strategy.js";
import { readAnnotations } from "./annotations.js";
import { brokerageAccountFacts } from "./facts.js";

interface PortfolioAtOptions {
  readonly vault: ProfileId;
  readonly asOf: IsoDate;
  readonly strategy: StrategyState;
  readonly lang: UiLang;
  readonly accounts?: readonly AccountId[] | null;
  /** Extra owned saved/watch/detail subjects; a cache entry alone never grants ownership. */
  readonly instrumentIds?: readonly InstrumentId[];
  /** Python portfolio.build's valuation history; null explicitly requests all history. */
  readonly historyDays?: number | null;
}
export type PortfolioAtRequest = PortfolioAtOptions & MarketInput;
export type PortfolioAtResult =
  | { readonly ok: true; readonly value: views.PortfolioViewState }
  | {
      readonly ok: false;
      readonly reason: "unknown_account" | "unknown_instrument" | "invalid_identity";
    };
export type PortfolioViewRequest = PortfolioAtRequest & {
  readonly clock: views.ViewClock;
  readonly forOwner: boolean;
};

/** Validate selected context without computing a portfolio; identity members become canonical roots. */
export function canonicalAccountFilter(
  read: Read,
  members?: readonly AccountId[] | null,
):
  | { readonly ok: true; readonly accounts: readonly AccountId[] | null }
  | { readonly ok: false; readonly reason: "unknown_account" } {
  if (members == null) return { ok: true, accounts: null };
  const accounts = new Set<AccountId>();
  for (const member of members) {
    const account = accountByMemberGid(read, member);
    if (account === undefined || account.type !== "brokerage")
      return { ok: false, reason: "unknown_account" };
    accounts.add(asAccountId(account.gid));
  }
  return { ok: true, accounts: [...accounts].sort() };
}

/** Explicit fact seam used by production services and copied-source parity projectors alike. */
export function portfolioViewInputs(read: Read, request: PortfolioViewRequest) {
  const subjects = new Set<InstrumentId>(request.instrumentIds ?? []);
  for (const row of watchlist(read)) subjects.add(row.instrument as InstrumentId);
  // Attention labels also cover saved signal subjects, independently of holdings/watch membership.
  const owned = vaultInstrumentGids(read);
  for (const signal of openSignals(read)) {
    if (signal.instrument === null) continue;
    const canonical = instrumentGid(read, signal.instrument);
    if (canonical !== undefined && owned.has(canonical)) subjects.add(canonical as InstrumentId);
  }
  const loaded = portfolioAt(read, { ...request, instrumentIds: [...subjects] });
  if (!loaded.ok) return loaded;
  const state = loaded.value;
  const { facts, annotations } = readAnnotations(read, {
    portfolio: state,
    clock: request.clock,
    lang: request.lang,
  });
  const options: views.ViewOptions = {
    lang: request.lang,
    forOwner: request.forOwner,
    accounts: state.accountFilter,
  };
  return { ok: true as const, value: { state, facts, annotations, options } };
}

export function portfolioAt(read: Read, request: PortfolioAtRequest): PortfolioAtResult {
  if (read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid !== request.vault)
    return { ok: false, reason: "invalid_identity" };
  const accounts = brokerageAccountFacts(read, request.lang);
  const selected = canonicalAccountFilter(read, request.accounts);
  if (!selected.ok) return selected;
  const filter = selected.accounts;
  const txns = transactions(read).sort(compareChronological);
  const renamed = renames(read);
  const snapshot = buildSnapshot(request.vault, txns, request.asOf, { renames: renamed });
  const referenced = new Set<InstrumentId>();
  for (const txn of txns) if (txn.instrumentId !== null) referenced.add(txn.instrumentId);
  for (const rename of renamed) {
    referenced.add(rename.oldInstrumentId);
    referenced.add(rename.newInstrumentId);
  }
  const owned = vaultInstrumentGids(read);
  for (const member of request.instrumentIds ?? []) {
    const id = instrumentGid(read, member);
    if (id === undefined || !owned.has(id)) return { ok: false, reason: "unknown_instrument" };
    referenced.add(id as InstrumentId);
  }
  const canonicalReferenced = new Set<InstrumentId>();
  for (const id of referenced) {
    const canonical = instrumentGid(read, id);
    if (canonical === undefined) return { ok: false, reason: "invalid_identity" };
    canonicalReferenced.add(canonical as InstrumentId);
  }
  const instruments = new Map<InstrumentId, Instrument>();
  // loadInstruments keys preserve requested aliases; the values carry authoritative canonical ids.
  for (const instrument of loadInstruments(read, canonicalReferenced).values())
    instruments.set(instrument.id, instrument);
  for (const id of canonicalReferenced)
    if (!instruments.has(id)) return { ok: false, reason: "invalid_identity" };
  const cached = resolveMarketInput(request, instruments.values());
  const bars = new Map(
    [...instruments.keys()].map((id) => [
      id,
      cached.series(id).filter((bar) => bar.date <= request.asOf),
    ]),
  );
  const manual = new Map<InstrumentId, ManualValuation[]>();
  for (const valuation of manualValuations(read)) {
    if (!instruments.has(valuation.instrumentId) || valuation.asOf > request.asOf) continue;
    const list = manual.get(valuation.instrumentId) ?? [];
    list.push(valuation);
    manual.set(valuation.instrumentId, list);
  }
  for (const list of manual.values())
    list.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
  const historyDays = request.historyDays === undefined ? 800 : request.historyDays;
  const since = historyDays === null ? null : addDays(request.asOf, -historyDays);
  const heldIds = new Set(snapshot.holdings.map((holding) => holding.instrumentId));
  const valuationView = marketView({
    asOf: request.asOf,
    instruments: new Map([...instruments].filter(([id]) => heldIds.has(id))),
    bars: new Map(
      [...bars]
        .filter(([id]) => heldIds.has(id))
        .map(([id, series]) => [
          id,
          since === null ? series : series.filter((bar) => bar.date >= since),
        ]),
    ),
    manualValuations: new Map([...manual].filter(([id]) => heldIds.has(id))),
  });
  const config = request.strategy.config;
  const profile = profileOf(read);
  if (profile === undefined) return { ok: false, reason: "invalid_identity" };
  const base = config?.baseCurrency ?? toCurrency(profile.baseCurrency);
  const policy = config?.data ?? DEFAULT_DATA_QUALITY;
  const needs = fxCurrenciesFor(snapshot, valuationView, base);
  const fx = new InMemoryFxLookup(
    preloadRates(
      [...needs.currencies].flatMap((currency) => cached.fxRates(currency)),
      needs.currencies,
      request.asOf,
      needs.oldest,
    ),
  );
  const accountIds = filter === null ? null : new Set(filter);
  const valued = valuePortfolio(snapshot, valuationView, fx, base, policy.maxPriceAgeDays, {
    accountIds,
    maxFxAgeDays: policy.maxFxAgeDays,
  });
  const allocation =
    config !== null && config.allocation.buckets.length > 0
      ? allocate(valued, config.allocation, { accountIds })
      : null;
  return {
    ok: true,
    value: {
      vault: request.vault,
      asOf: request.asOf,
      base,
      accounts,
      accountFilter: filter,
      txns,
      snapshot,
      market: valuationView,
      instruments,
      historyBars: bars,
      valued,
      allocation,
      config,
    },
  };
}
