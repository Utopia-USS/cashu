import { parseDateTime } from "@cashu/domain";
import { asAccountId, asInstrumentId, market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { openTestStore } from "../../testing/store.js";
import { brokerage, otherVault, stock } from "../commands/testing/fixtures.js";
import { assertOrderedDelivery } from "../testing/delivery.js";
import { cachedClose, HOUSEHOLD_NOW, household } from "../testing/household.js";
import { det, instrument, ulid } from "../testing/kit.js";
import { readAccounts } from "./accounts.js";
import { readFacts } from "./facts.js";
import { readOverview } from "./overview.js";
import { type PortfolioViewRequest, portfolioAt, portfolioViewInputs } from "./portfolio.js";
import {
  positionHistory,
  readAllocation,
  readPositionChart,
  readPositionDetail,
  readPositions,
} from "./positions.js";
import { readWatchlist } from "./watchlist.js";

function request(h: ReturnType<typeof household>): PortfolioViewRequest {
  return {
    vault: h.vault,
    asOf: "2026-10-31",
    prices: h.prices,
    strategy: h.strategy,
    lang: "en",
    forOwner: true,
    clock: { now: parseDateTime(HOUSEHOLD_NOW), today: "2026-10-31", timeZone: "Europe/Warsaw" },
  };
}

describe("production investment read services", () => {
  it("labels saved open-signal subjects without trades/watch membership or extra held/watch hints", () => {
    const h = household();
    const store = openTestStore();
    const saved = instrument(h.ev, ["isin", "PL0000000204"], {
      symbol: "SIGONLY",
      name: "Synthetic signal only",
    });
    const alert = ulid(8500),
      signal = ulid(8501);
    store.applyEnvelopes([
      ...h.events,
      ...saved.events,
      h.ev.make("alert.created", alert, {
        instrument: saved.gid,
        scope: "instrument",
        kind: "price_above",
        params: { level: 10 },
      }),
      h.ev.make("signal.opened", signal, {
        instrument: saved.gid,
        ruleId: `alert:${alert}`,
        kind: "alert:price_above",
        dedupKey: `alert:${alert}`,
        payload: {
          title: "Synthetic price",
          close: "12",
          level: "10",
          currency: "PLN",
          unit: "price",
        },
      }),
    ]);
    const input = request(h),
      read = store.read.bind(store);
    const assembled = portfolioViewInputs(read, input);
    if (!assembled.ok) throw new Error(assembled.reason);
    expect(assembled.value.state.instruments.has(asInstrumentId(saved.gid))).toBe(true);
    expect(assembled.value.state.market.instruments.has(asInstrumentId(saved.gid))).toBe(false);
    expect(assembled.value.facts.watched.some((row) => row.instrumentId === saved.gid)).toBe(false);
    expect(
      assembled.value.facts.subjects.find((row) => row.instrument.id === saved.gid)?.hintsWanted,
    ).toBe(false);
    expect(assembled.value.annotations.get(asInstrumentId(saved.gid))?.hints).toEqual([]);
    const overview = readOverview(read, { ...input, newestRateDate: null });
    if (!overview.ok) throw new Error(overview.reason);
    const attention = overview.value.attention.find((row) => row.signal_id === signal);
    expect(attention?.instrument_label).toBe("SIGONLY");
    expect(attention?.message_params?.label).toBe("SIGONLY");
    const detail = readPositionDetail(read, { ...input, instrument: asInstrumentId(saved.gid) });
    if (!detail.ok) throw new Error(detail.reason);
    expect(detail.value.entry.state).toBe("saved");
    expect(detail.value.hints).toEqual([]);
    store.close();
  });

  it("does not load missing or foreign stored signal refs, and still refuses explicit foreign requests", () => {
    const h = household();
    const store = openTestStore();
    const foreign = otherVault();
    const foreignId = stock(foreign, "FOREIGN", "PL0000000998"),
      missing = ulid(8599);
    store.applyEnvelopes([
      ...h.events,
      ...[foreignId, missing].map((id, index) =>
        h.ev.make("signal.opened", ulid(8510 + index), {
          instrument: id,
          ruleId: "research:synthetic",
          kind: "research",
          dedupKey: `research:synthetic|i:${id}`,
          payload: {},
        }),
      ),
    ]);
    const input = request(h),
      read = store.read.bind(store);
    const assembled = portfolioViewInputs(read, input);
    if (!assembled.ok) throw new Error(assembled.reason);
    for (const id of [foreignId, missing])
      expect(assembled.value.state.instruments.has(asInstrumentId(id))).toBe(false);
    const overview = readOverview(read, { ...input, newestRateDate: null });
    if (!overview.ok) throw new Error(overview.reason);
    for (const id of [foreignId, missing])
      expect(
        overview.value.attention.find((row) => row.instrument_id === id)?.instrument_label,
      ).toBeNull();
    expect(
      portfolioViewInputs(read, { ...input, instrumentIds: [asInstrumentId(foreignId)] }),
    ).toEqual({ ok: false, reason: "unknown_instrument" });
    expect(
      portfolioViewInputs(read, { ...input, instrumentIds: [asInstrumentId(missing)] }),
    ).toEqual({ ok: false, reason: "unknown_instrument" });
    foreign.store.close();
    store.close();
  });

  it("keeps owner KPI filtering separate from agent results and invalidates no cached DTO", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes([
      ...h.events,
      h.ev.make("signal.opened", ulid(8300), {
        kind: "allocation_drift",
        ruleId: "satellite",
        dedupKey: "satellite",
        payload: { bucket_id: "synthetic", bucket_generic: false },
      }),
      h.ev.make("signal.opened", ulid(8301), {
        instrument: h.first,
        kind: "position_concentration",
        ruleId: "weight",
        dedupKey: `weight|i:${h.first}`,
        payload: {},
      }),
    ]);
    const input = { ...request(h), newestRateDate: null };
    const owner = readOverview(store.read.bind(store), { ...input, forOwner: true });
    const agent = readOverview(store.read.bind(store), { ...input, forOwner: false });
    expect(owner.ok).toBe(true);
    expect(agent.ok).toBe(true);
    if (!owner.ok || !agent.ok) throw new Error("synthetic overview refused");
    expect(owner.value.kpis.signals.info).toBe(1);
    expect(agent.value.kpis.signals.info).toBe(2);
    expect(owner.value.attention_total).toBe(1);
    expect(agent.value.attention_total).toBe(2);
    expect(owner.value.allocation).toEqual(agent.value.allocation);
    const serialized = JSON.stringify(agent, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value instanceof Map ? [...value] : value,
    );
    expect(serialized).not.toMatch(/"(?:rank|hlc|eid)":/);
    store.close();
  });

  it("validates selected accounts but keeps watched holdings and hints whole-profile", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes([
      ...h.events,
      h.ev.make("watchlist.added", det("watchlist_items", h.first), {
        instrument: h.first,
        source: "user",
      }),
    ]);
    const input = request(h),
      read = store.read.bind(store);
    const all = readWatchlist(read, { ...input, accounts: null });
    const subset = readWatchlist(read, { ...input, accounts: [asAccountId(h.accountB)] });
    const empty = readWatchlist(read, { ...input, accounts: [] });
    expect(all.ok).toBe(true);
    expect(subset).toEqual(all);
    expect(empty).toEqual(all);
    if (!all.ok) throw new Error(all.reason);
    expect(all.value.find((row) => row.instrument_id === h.first)?.held).toBe(true);
    const foreign = otherVault();
    const account = brokerage(foreign, "Synthetic foreign");
    expect(readWatchlist(read, { ...input, accounts: [asAccountId(account)] })).toEqual({
      ok: false,
      reason: "unknown_account",
    });
    foreign.store.close();
    store.close();
  });

  it("reports an unbounded held newest bar while ignoring a later unrelated bar and clipping valuation", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    h.prices.upsertBars(
      market.marketSymbol("yahoo", "AAA.WA"),
      [cachedClose("2026-11-02", "19")],
      parseDateTime(HOUSEHOLD_NOW),
    );
    h.prices.upsertBars(
      market.marketSymbol("yahoo", "BBB.WA"),
      [cachedClose("2026-11-03", "99")],
      parseDateTime(HOUSEHOLD_NOW),
    );
    const input = request(h);
    const overview = readOverview(store.read.bind(store), {
      ...input,
      newestRateDate: "2026-11-04",
    });
    expect(overview.ok).toBe(true);
    if (!overview.ok) throw new Error(overview.reason);
    expect(overview.value.freshness.prices.newest_bar).toBe("2026-11-02");
    expect(overview.value.freshness.fx.newest_rate).toBe("2026-11-04");
    const state = portfolioAt(store.read.bind(store), input);
    if (!state.ok) throw new Error(state.reason);
    expect(state.value.market.bars.get(asInstrumentId(h.first))?.at(-1)?.date).toBe("2026-10-31");
    expect(state.value.valued.valued[0]?.price?.toString()).toBe("12");
    store.close();
  });

  it("orders equal-trigger alerts by their original create anchor after delivery and rebuild", () => {
    const h = household();
    const first = ulid(8201),
      second = ulid(8200);
    const events = [
      ...h.events,
      h.ev.make(
        "alert.created",
        first,
        { instrument: h.watched, scope: "instrument", kind: "price_above", params: { level: 10 } },
        { wall: 100 },
      ),
      h.ev.make(
        "alert.created",
        second,
        { instrument: h.watched, scope: "instrument", kind: "price_above", params: { level: 11 } },
        { wall: 101 },
      ),
      h.ev.make(
        "alert.evaluated",
        first,
        { triggered: true, lastTriggeredAt: HOUSEHOLD_NOW },
        { wall: 200 },
      ),
      h.ev.make(
        "alert.evaluated",
        second,
        { triggered: true, lastTriggeredAt: HOUSEHOLD_NOW },
        { wall: 201 },
      ),
    ];
    const input = request(h);
    const result = assertOrderedDelivery(events, (store) =>
      readWatchlist(store.read.bind(store), input),
    );
    expect(result.ok).toBe(true);
    assertOrderedDelivery(events, (store) => {
      const loaded = portfolioAt(store.read.bind(store), {
        ...input,
        instrumentIds: [asInstrumentId(h.watched)],
      });
      if (!loaded.ok) throw new Error(loaded.reason);
      const facts = readFacts(store.read.bind(store), {
        portfolio: loaded.value,
        clock: input.clock,
      });
      const subject = facts.subjects.find((row) => row.instrument.id === h.watched);
      expect(subject?.hintTriggeredAlerts.map((row) => row.id)).toEqual([first, second]);
      return subject?.freshnessTriggeredAlerts;
    });
  });

  it("compares actual ordered service DTOs after shuffled/duplicate delivery and rebuild", () => {
    const h = household();
    const input = request(h);
    const projected = assertOrderedDelivery(h.events, (store) => {
      const read = store.read.bind(store);
      return {
        positions: readPositions(read, input),
        overview: readOverview(read, { ...input, newestRateDate: null }),
        allocation: readAllocation(read, input),
        accounts: readAccounts(read, input),
        watchlist: readWatchlist(read, input),
        detail: readPositionDetail(read, { ...input, instrument: asInstrumentId(h.first) }),
        chart: readPositionChart(read, { ...input, instrument: asInstrumentId(h.first) }),
      };
    });
    for (const result of Object.values(projected)) expect(result.ok).toBe(true);
  });

  it("keeps future manual history and transactions in detail while valuation remains asOf", () => {
    const h = household();
    const future = "2027-01-01";
    const valuation = det("inv_manual_valuations", h.first, future);
    const store = openTestStore();
    store.applyEnvelopes([
      ...h.events,
      h.ev.make("valuation.set", valuation, {
        instrument: h.first,
        asOf: future,
        unitValue: "99",
        currency: "PLN",
        note: "Synthetic future value",
      }),
    ]);
    const input = request(h);
    const state = portfolioAt(store.read.bind(store), input);
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error(state.reason);
    expect(state.value.market.manualValuations.get(asInstrumentId(h.first)) ?? []).toEqual([]);
    const history = positionHistory(store.read.bind(store), asInstrumentId(h.first));
    expect(history.manualValuations.map((row) => [row.id, row.asOf])).toEqual([
      [valuation, future],
    ]);
    const detail = readPositionDetail(store.read.bind(store), {
      ...input,
      instrument: asInstrumentId(h.first),
    });
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error(detail.reason);
    expect(detail.value.manual_valuations.map((row) => row.id)).toContain(valuation);
    expect(detail.value.transactions.some((row) => row.trade_date === "2026-11-10")).toBe(true);
    store.close();
  });

  it("keeps snoozed signals and historical triggered alerts in freshness, with distinct hint filters", () => {
    const h = household();
    const store = openTestStore();
    const signal = ulid(8000);
    const active = ulid(8100),
      muted = ulid(8101),
      expired = ulid(8102),
      deleted = ulid(8103);
    const events = [
      ...h.events,
      h.ev.make("signal.opened", signal, {
        instrument: h.first,
        kind: "position_concentration",
        ruleId: "weight",
        dedupKey: `weight|i:${h.first}`,
        payload: { weight: 0.5, max_weight: 0.3 },
      }),
      h.ev.make("signal.snoozed", signal, { until: "2026-11-01T00:00:00Z" }),
    ];
    for (const id of [active, muted, expired, deleted])
      events.push(
        h.ev.make("alert.created", id, {
          instrument: h.first,
          scope: "instrument",
          kind: "price_above",
          params: { level: 10 },
          expiresAt: id === expired ? "2026-10-30T12:00:00Z" : null,
        }),
        h.ev.make("alert.evaluated", id, {
          triggered: true,
          lastTriggeredAt: "2026-10-20T12:00:00Z",
        }),
      );
    events.push(
      h.ev.make("alert.statusSet", muted, { status: "muted", snoozedUntil: null }),
      h.ev.make("alert.deleted", deleted),
    );
    store.applyEnvelopes(events);
    const input = request(h);
    const loaded = portfolioAt(store.read.bind(store), input);
    if (!loaded.ok) throw new Error(loaded.reason);
    const facts = readFacts(store.read.bind(store), {
      portfolio: loaded.value,
      clock: input.clock,
    });
    const subject = facts.subjects.find((row) => row.instrument.id === h.first);
    expect(subject?.allOpenSignals.map((row) => row.id)).toEqual([signal]);
    expect(subject?.allOpenSignals[0]?.snoozedUntil).not.toBeNull();
    expect(subject?.hintTriggeredAlerts.map((row) => row.id)).toEqual([active]);
    expect(subject?.freshnessTriggeredAlerts.map((row) => row.id)).toEqual([
      active,
      muted,
      expired,
    ]);
    expect(facts.alerts.some((row) => row.id === deleted)).toBe(false);
    const overview = readOverview(store.read.bind(store), { ...input, newestRateDate: null });
    if (!overview.ok) throw new Error(overview.reason);
    expect(overview.value.attention_total).toBe(0);
    expect(overview.value.attention_snoozed).toBe(1);
    expect(overview.value.kpis.signals.info).toBe(1);
    const positions = readPositions(store.read.bind(store), input);
    if (!positions.ok) throw new Error(positions.reason);
    expect(
      positions.value.positions.find((row) => row.instrument.id === h.first)?.open_signals,
    ).toBe(1);
    store.close();
  });
});
