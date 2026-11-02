/** Genuine native investment calculations over the existing copied-source compatibility facts. */
import { investments as inv, parsePyJson } from "@cashu/domain";
import type { InvestmentReads } from "@cashu/mcp";
import {
  investmentsViews,
  investmentsQueries as Q,
  investmentsResearch as research,
} from "@cashu/store";
import type { PythonDb } from "../../sources/pythonDb.ts";
import {
  copiedProjectionInput,
  copiedWarningMessages,
  type NativeViewSource,
  nativeViewSources,
} from "../investments/viewSource.ts";

function calendar(db: PythonDb, source: NativeViewSource): inv.market.CalendarView {
  const read = source.vault.store.read.bind(source.vault.store),
    today = source.clock.today;
  let feeds = inv.market.emptyFeeds(today, 14, ["offline"]);
  const cached = db.files().read("market/calendar.json");
  if (cached !== undefined) {
    try {
      const data = parsePyJson(new TextDecoder("utf-8", { fatal: true }).decode(cached));
      if (data !== null && typeof data === "object" && !Array.isArray(data))
        feeds = data as inv.market.CalendarFeeds;
    } catch {
      /* Python's unreadable/missing cache is the explicit offline state. */
    }
  }
  const held = Q.heldSince(read, today),
    ids = new Set([...held.keys(), ...Q.watchlist(read).map((w) => w.instrument)]);
  const instruments = [...Q.loadInstruments(read, ids).values()].map((i) => ({
    id: i.id,
    name: i.name,
    symbol: i.symbol,
    mic: i.mic,
    label: null,
    yahoo: i.aliases.find((a) => a.namespace === "yahoo")?.value ?? null,
    held: held.has(i.id),
  }));
  const notes = research
    .notes(read, research.eventInstant(`${source.clock.today}T12:00:00.000000Z`), { limit: null })
    .map((n) => ({
      id: n.gid,
      kind: n.kind,
      title: n.title,
      instrumentId: n.instrument,
      segment: n.segment,
      details: n.details,
    }));
  return inv.market.calendarEvents({
    feeds,
    stale: !inv.market.isFresh(feeds, today, 14, source.clock.now) || inv.market.isStale(feeds),
    today,
    instruments,
    notes,
    lang: "pl",
  });
}
export function bindInvestmentReads(db: PythonDb, profileId: number): InvestmentReads {
  const source = nativeViewSources(db).find((s) => s.profile.id === profileId);
  if (source === undefined) throw new Error("missing native investment source");
  const read = source.vault.store.read.bind(source.vault.store);
  const input = () => {
    const value = copiedProjectionInput(db, source, { forOwner: false });
    return { ...value, options: { ...value.options, lang: "pl" as const } };
  };
  return {
    positions: () => inv.views.positionsView(input()),
    overview: () => {
      const data = input(),
        dates = data.state.valued.valued.flatMap(
          (h) => source.marketData.data.lastBarDate(h.instrument.id) ?? [],
        );
      const value = inv.views.overviewView({
        ...data,
        strategyStatus: investmentsViews.nativeStrategyStatus(source.strategy),
        newestRateDate: db.investmentsViews.newestRateDate(),
        newestBarDate: dates.toSorted().at(-1) ?? null,
      });
      return { ...value, warnings: copiedWarningMessages(value.warnings, data.state, source) };
    },
    reviewContext: () =>
      investmentsViews.readReviewContext(read, {
        clock: investmentsViews.makeReviewClock(source.clock),
        config: source.strategy.config,
        calendar: calendar(db, source),
        lang: "pl",
      }),
    strategyStatus: () => {
      const prefix = `profiles/${source.profile.slug}/`,
        files = db.files();
      return investmentsViews.projectStoredStrategyStatus(read, {
        state: source.strategy,
        profileBase: inv.toCurrency(source.profile.baseCurrency ?? "PLN"),
        lang: "pl",
        files: {
          yaml: `$DATA_DIR/${prefix}strategy.yaml`,
          md: `$DATA_DIR/${prefix}strategy.md`,
          yamlExists: files.read(`${prefix}strategy.yaml`) !== undefined,
          mdExists: files.read(`${prefix}strategy.md`) !== undefined,
        },
      });
    },
  };
}
