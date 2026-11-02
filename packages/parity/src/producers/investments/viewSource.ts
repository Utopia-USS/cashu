/** Native view context from the existing copied-source/genesis harness, never result replay. */
import { createHash } from "node:crypto";
import { D, type DateTime, investments as inv, parseDateTime, toStorage } from "@cashu/domain";
import type * as macro from "@cashu/domain/investments/macro";
import type { SignalPolarity } from "@cashu/domain/investments/rules";
import * as strategyDomain from "@cashu/domain/investments/strategy";
import { investmentsQueries, type investmentsServices, investmentsViews } from "@cashu/store";
import type { ProfileRow, PythonDb } from "../../sources/pythonDb.ts";
import { genesisRun, type VaultRun } from "../store/genesisRun.ts";
import { signalClock } from "./signals.ts";
import { profileStrategy } from "./strategy.ts";

export interface NativeViewSource {
  readonly profile: ProfileRow;
  readonly vault: VaultRun;
  readonly strategy: investmentsServices.StrategyState;
  readonly clock: inv.views.ViewClock;
  readonly marketData: { readonly data: inv.market.CachedMarketData; readonly version: string };
  readonly macroCloses: macro.MacroCloses;
  readonly request: {
    readonly vault: inv.ProfileId;
    readonly asOf: string;
    readonly clock: inv.views.ViewClock;
    readonly marketData: { readonly data: inv.market.CachedMarketData; readonly version: string };
    readonly strategy: investmentsServices.StrategyState;
    readonly lang: "en";
    readonly forOwner: false;
  };
}

const aware = (value: string | null) => (value === null ? null : parseDateTime(value));
const decimal = (value: string | null) => (value === null ? null : D(value));

/** Raw instrument-keyed snapshot, preserving source/fetch metadata and actual canonical identities. */
class CopiedViewMarket implements inv.market.CachedMarketData {
  readonly version: string;
  private readonly barsById = new Map<inv.InstrumentId, inv.PriceBar[]>();
  private readonly ratesByQuote = new Map<inv.Currency, inv.FxRate[]>();

  constructor(db: PythonDb, vault: VaultRun) {
    const byId = new Map(
      [...vault.sources]
        .filter(([, source]) => source.table === "inv_instruments")
        .map(([gid, source]) => [Number(source.localId), gid]),
    );
    const bars = db.investments.priceBars([...byId.keys()]);
    const rates = db.investments.fxRates();
    this.version = createHash("sha256").update(JSON.stringify({ bars, rates })).digest("hex");
    const read = vault.store.read.bind(vault.store);
    for (const bar of bars) {
      const gid = byId.get(bar.instrumentId);
      const instrument =
        gid === undefined ? undefined : investmentsQueries.loadInstrument(read, gid);
      if (instrument === undefined)
        throw new Error("copied market bar has no canonical instrument");
      const id = instrument.id;
      const rows = this.barsById.get(id) ?? [];
      rows.push(
        inv.priceBar({
          instrumentId: id,
          date: bar.date,
          close: D(bar.close),
          open: decimal(bar.open),
          high: decimal(bar.high),
          low: decimal(bar.low),
          volume: bar.volume,
          currency: bar.currency === null ? null : inv.toCurrency(bar.currency),
          source: bar.source,
          fetchedAt: aware(bar.fetchedAt),
        }),
      );
      this.barsById.set(id, rows);
    }
    for (const rate of rates) {
      const quote = inv.toCurrency(rate.quote);
      const rows = this.ratesByQuote.get(quote) ?? [];
      rows.push(
        inv.fxRate({
          base: inv.toCurrency(rate.base),
          quote,
          date: rate.date,
          rate: D(rate.rate),
          source: rate.source,
          fetchedAt: aware(rate.fetchedAt),
        }),
      );
      this.ratesByQuote.set(quote, rows);
    }
    for (const rows of this.barsById.values())
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  series(id: inv.InstrumentId): readonly inv.PriceBar[] {
    return this.barsById.get(id) ?? [];
  }
  fxRates(quote: inv.Currency): readonly inv.FxRate[] {
    return this.ratesByQuote.get(quote) ?? [];
  }
  lastBarDate(id: inv.InstrumentId): string | null {
    return this.series(id).at(-1)?.date ?? null;
  }
  firstBarDate(id: inv.InstrumentId): string | null {
    return this.series(id)[0]?.date ?? null;
  }
  hasBarsFetchedBefore(id: inv.InstrumentId, before: string, fetchedBefore: DateTime): boolean {
    return this.series(id).some(
      (bar) =>
        bar.date < before &&
        (bar.fetchedAt === null || toStorage(bar.fetchedAt) < toStorage(fetchedBefore)),
    );
  }
  lastRateDate(quote: inv.Currency): string | null {
    return this.fxRates(quote).at(-1)?.date ?? null;
  }
  firstRateDate(quote: inv.Currency): string | null {
    return this.fxRates(quote)[0]?.date ?? null;
  }
  hasRateOnOrBefore(quote: inv.Currency, on: string): boolean {
    return this.fxRates(quote).some((rate) => rate.date <= on);
  }
}

function canonicalStrategy(
  config: strategyDomain.StrategyConfig | null,
  vault: VaultRun,
): strategyDomain.StrategyConfig | null {
  if (config === null) return null;
  const instruments = new Map(
    [...vault.sources]
      .filter(([, source]) => source.table === "inv_instruments")
      .map(([gid, source]) => [source.localId, gid]),
  );
  const id = (value: string): inv.InstrumentId =>
    inv.asInstrumentId(instruments.get(value) ?? value);
  const filter = (value: unknown, field = ""): unknown => {
    if (value instanceof Set)
      return new Set(
        [...value].map((member) =>
          typeof member === "string" && (field === "instrumentIds" || field === "ids")
            ? id(member)
            : member,
        ),
      );
    if (Array.isArray(value)) return value.map((member) => filter(member, field));
    if (
      value !== null &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    )
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [key, filter(member, key)]),
      );
    return value;
  };
  return {
    ...config,
    allocation: {
      ...config.allocation,
      buckets: config.allocation.buckets.map((bucket) => ({
        ...bucket,
        match: { ...bucket.match, instrumentIds: new Set([...bucket.match.instrumentIds].map(id)) },
      })),
    },
    rules: config.rules.map((rule) => {
      const params = rule.params;
      if (typeof params !== "object" || params === null || !("filter" in params)) return rule;
      // Keep the established native Params class identity used by chart/evaluator guards.
      const descriptors = Object.getOwnPropertyDescriptors(params);
      const descriptor = descriptors.filter;
      if (descriptor === undefined || !("value" in descriptor))
        throw new Error("native rule filter is not stored data");
      descriptors.filter = { ...descriptor, value: filter(descriptor.value) };
      return {
        ...rule,
        params: Object.create(Object.getPrototypeOf(params), descriptors) as typeof rule.params,
      };
    }),
  };
}

const cached = new WeakMap<PythonDb, readonly NativeViewSource[]>();
export function nativeViewSources(db: PythonDb): readonly NativeViewSource[] {
  const found = cached.get(db);
  if (found !== undefined) return found;
  const genesis = genesisRun(db);
  const macroCloses: Record<string, macro.MacroClose[]> = {};
  for (const row of db.investmentsViews.macroCloses()) {
    const values = macroCloses[row.series] ?? [];
    values.push([row.date, Number(row.close)]);
    macroCloses[row.series] = values;
  }
  const out: NativeViewSource[] = [];
  for (const profile of db.profiles()) {
    if (!db.enabledModules(profile.id).includes("investments")) continue;
    const vault = genesis.vaults.get(profile.id);
    if (vault === undefined) throw new Error("native view vault is absent");
    const read = vault.store.read.bind(vault.store);
    const status = profileStrategy(db, profile);
    const strategy: investmentsServices.StrategyState = {
      state: status.state,
      result: status.result,
      config: canonicalStrategy(strategyDomain.usableConfig(status), vault),
      issues: status.result?.issues ?? [],
      inactiveRules: status.result?.inactiveRules ?? [],
      sha256: status.sha256,
      version: investmentsQueries.latestStrategyVersion(read) ?? null,
      changed: status.changed,
      readError: status.readError,
    };
    const data = new CopiedViewMarket(db, vault);
    const marketData = { data, version: data.version };
    const clock: inv.views.ViewClock = {
      now: parseDateTime(signalClock(db)),
      today: db.asOf,
      timeZone: "Europe/Warsaw",
    };
    const request = {
      vault: inv.asProfileId(vault.store.vault),
      asOf: db.asOf,
      clock,
      marketData,
      strategy,
      lang: "en" as const,
      forOwner: false as const,
    };
    out.push({ profile, vault, strategy, clock, marketData, macroCloses, request });
  }
  cached.set(db, out);
  return out;
}

export function copiedSourceId(
  source: Pick<NativeViewSource, "vault">,
  gid: string,
  table?: string,
): number {
  const row = source.vault.sources.get(gid);
  if (row === undefined || (table !== undefined && row.table !== table))
    throw new Error("copied view source identity is absent or has the wrong table");
  return Number(row.localId);
}

/** Only structured display references change. No text/context is scanned or rewritten. */
export function copiedWarningMessage(
  warning: inv.PortfolioWarning,
  source: Pick<NativeViewSource, "vault">,
): string {
  const adapted: Record<string, unknown> = { ...warning };
  for (const [field, table] of [
    ["accountId", "accounts"],
    ["instrumentId", "inv_instruments"],
    ["txnId", "inv_transactions"],
  ] as const) {
    const reference = adapted[field];
    if (typeof reference === "string")
      adapted[field] = String(copiedSourceId(source, reference, table));
  }
  return inv.warningMessage(adapted as unknown as inv.PortfolioWarning);
}

export function copiedWarningMessages<T extends { readonly message: string }>(
  rows: readonly T[],
  state: inv.views.PortfolioViewState,
  source: NativeViewSource,
): T[] {
  const structured = inv.allWarnings(state.valued);
  if (structured.length !== rows.length)
    throw new Error("native warning projection changed its shape");
  return rows.map((row, i) => {
    const warning = structured[i];
    if (warning === undefined) throw new Error("native warning fact is absent");
    return { ...row, message: copiedWarningMessage(warning, source) };
  });
}

export function copiedSourceGid(source: NativeViewSource, table: string, id: number): string {
  const found = [...source.vault.sources].find(
    ([, row]) => row.table === table && Number(row.localId) === id,
  );
  if (found === undefined)
    throw new Error("copied view reference has no exported canonical identity");
  return found[0];
}

function copiedPayload(value: unknown, source: NativeViewSource, field = ""): unknown {
  const tables: Readonly<Record<string, string>> = {
    note_id: "research_notes",
    note_ids: "research_notes",
    instrument_id: "inv_instruments",
    instrument_ids: "inv_instruments",
    account_id: "accounts",
    account_ids: "accounts",
    signal_id: "inv_signals",
    signal_ids: "inv_signals",
    alert_id: "alerts",
    alert_ids: "alerts",
  };
  if (Array.isArray(value)) return value.map((entry) => copiedPayload(entry, source, field));
  if (typeof value === "bigint" && tables[field] !== undefined)
    return copiedSourceGid(source, tables[field], Number(value));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copiedPayload(entry, source, key)]),
    );
  return value;
}

/** Explicit legacy compatibility facts. Production services always use effective state/event ranks. */
export function copiedProjectionInput(
  db: PythonDb,
  source: NativeViewSource,
  additional: {
    readonly instrumentIds?: readonly inv.InstrumentId[];
    readonly forOwner?: boolean;
  } = {},
): inv.views.PortfolioProjectionInput {
  const loaded = investmentsViews.portfolioViewInputs(
    source.vault.store.read.bind(source.vault.store),
    { ...source.request, ...additional },
  );
  if (!loaded.ok) throw new Error(`native view input refused: ${loaded.reason}`);
  const input = loaded.value;
  const rawSignals = new Map(db.investments.signals(source.profile.id).map((row) => [row.id, row]));
  const signals = input.facts.signals
    .map((signal) => {
      const raw = rawSignals.get(copiedSourceId(source, signal.id, "inv_signals"));
      if (raw === undefined) throw new Error("copied native signal has no source payload");
      return {
        ...signal,
        payload: copiedPayload(raw.payload ?? {}, source) as Readonly<Record<string, unknown>>,
      };
    })
    .sort((a, b) => copiedSourceId(source, a.id) - copiedSourceId(source, b.id));
  const alerts: inv.views.ViewAlert[] = db.investments
    .storedAlerts(source.profile.id)
    .map((row) => ({
      id: copiedSourceGid(source, "alerts", row.id),
      instrumentId:
        row.instrumentId === null
          ? null
          : inv.asInstrumentId(copiedSourceGid(source, "inv_instruments", row.instrumentId)),
      kind: row.kind,
      title: row.title,
      source: row.source,
      status: row.status as inv.alerts.EffectiveAlertStatus,
      params: copiedPayload(row.params, source) as Readonly<Record<string, unknown>>,
      polarity: row.polarity as SignalPolarity,
      severity: inv.parseSignalSeverity(row.severity),
      lastTriggeredAt: aware(row.lastTriggeredAt),
      expiresAt: aware(row.expiresAt),
      snoozedUntil: aware(row.snoozedUntil),
      createdAt: parseDateTime(row.createdAt),
      updatedAt: parseDateTime(row.updatedAt),
    }));
  const subjects = input.facts.subjects.map((subject) => ({
    ...subject,
    allOpenSignals: signals.filter((row) => row.instrumentId === subject.instrument.id),
    hintTriggeredAlerts: alerts.filter(
      (row) => row.instrumentId === subject.instrument.id && row.status === "triggered",
    ),
    freshnessTriggeredAlerts: alerts.filter((row) => row.instrumentId === subject.instrument.id),
    notes: subject.notes.map((note) => ({
      ...note,
      scored: { ...note.scored, id: copiedSourceId(source, note.id, "research_notes") },
    })),
  }));
  const watched = [...input.facts.watched].sort((a, b) =>
    toStorage(a.addedAt) < toStorage(b.addedAt)
      ? -1
      : toStorage(a.addedAt) > toStorage(b.addedAt)
        ? 1
        : copiedSourceId(source, a.id) - copiedSourceId(source, b.id),
  );
  const facts = { ...input.facts, subjects, signals, alerts, watched };
  const state = {
    ...input.state,
    accounts: [...input.state.accounts].sort(
      (a, b) => copiedSourceId(source, a.id, "accounts") - copiedSourceId(source, b.id, "accounts"),
    ),
  };
  return {
    ...input,
    state,
    facts,
    annotations: inv.plan.annotateSubjects(subjects, source.clock, input.options.lang),
  };
}

export function copiedAllSignalFacts(
  db: PythonDb,
  source: NativeViewSource,
): readonly inv.views.ViewSignal[] {
  const raw = new Map(db.investments.signals(source.profile.id).map((row) => [row.id, row]));
  return investmentsViews
    .allSignalFacts(source.vault.store.read.bind(source.vault.store))
    .map((signal) => {
      const row = raw.get(copiedSourceId(source, signal.id, "inv_signals"));
      if (row === undefined) throw new Error("copied signal episode is absent");
      return {
        ...signal,
        payload: copiedPayload(row.payload ?? {}, source) as Readonly<Record<string, unknown>>,
      };
    })
    .sort((a, b) => copiedSourceId(source, b.id) - copiedSourceId(source, a.id));
}

/** Lexical selectors come only from copied parsePyJson scalars or their unchanged message params. */
export function copiedJsonFloatPaths(
  value: unknown,
  prefix: readonly string[] = [],
): readonly (readonly string[])[] {
  const out: string[][] = [];
  const floats = (item: unknown, path: string[]) => {
    if (typeof item === "number") {
      out.push(path);
      return;
    }
    if (Array.isArray(item))
      item.forEach((entry, i) => {
        floats(entry, [...path, String(i)]);
      });
    else if (item !== null && typeof item === "object")
      for (const [key, entry] of Object.entries(item)) floats(entry, [...path, key]);
  };
  floats(value, [...prefix]);
  return out;
}

export function copiedScalarFloatPaths(
  value: unknown,
  source: NativeViewSource,
): readonly (readonly string[])[] {
  const out: (readonly string[])[] = [];
  const walk = (item: unknown, path: string[]) => {
    if (Array.isArray(item)) {
      item.forEach((entry, i) => {
        walk(entry, [...path, String(i)]);
      });
      return;
    }
    if (item === null || typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    const id = row.id ?? row.signal_id;
    if (typeof id === "string" && source.vault.sources.get(id)?.table === "inv_signals") {
      if (row.payload !== undefined)
        out.push(...copiedJsonFloatPaths(row.payload, [...path, "payload"]));
      if (row.message_params !== undefined)
        out.push(...copiedJsonFloatPaths(row.message_params, [...path, "message_params"]));
    }
    for (const [key, entry] of Object.entries(row)) walk(entry, [...path, key]);
  };
  walk(value, []);
  return out;
}
