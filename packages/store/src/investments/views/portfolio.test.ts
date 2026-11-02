import { addMicroseconds, D, parseDateTime } from "@cashu/domain";
import { asAccountId, asInstrumentId, asProfileId, market } from "@cashu/domain/investments";
import { buildRuleContext, RulesEngine } from "@cashu/domain/investments/rules";
import { loadStrategy } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { viewHash } from "../../snapshot.js";
import { openTestStore } from "../../testing/store.js";
import { brokerage, otherVault, stock } from "../commands/testing/fixtures.js";
import { assertOrderedDelivery } from "../testing/delivery.js";
import { cachedClose, HOUSEHOLD_NOW, household } from "../testing/household.js";
import { account, ulid } from "../testing/kit.js";
import { readAnnotations } from "./annotations.js";
import { readFacts } from "./facts.js";
import { portfolioAt } from "./portfolio.js";

function loaded(
  store: ReturnType<typeof openTestStore>,
  fixture: ReturnType<typeof household>,
  extra: Partial<Omit<Parameters<typeof portfolioAt>[1], "marketData">> = {},
) {
  const result = portfolioAt(store.read.bind(store), {
    vault: fixture.vault,
    asOf: "2026-10-31",
    prices: fixture.prices,
    strategy: fixture.strategy,
    lang: "en",
    instrumentIds: [asInstrumentId(fixture.watched), asInstrumentId(fixture.saved)],
    ...extra,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
const clock = (at = HOUSEHOLD_NOW) => ({
  now: parseDateTime(at),
  today: "2026-10-31",
  timeZone: "Europe/Warsaw",
});

describe("native portfolio loader and live annotations", () => {
  it("uses a real parsed strategy, values two accounts, keeps future transactions and builds historical holdings separately", () => {
    const h = household();
    const store = openTestStore();
    expect(store.applyEnvelopes(h.events).rejected).toEqual([]);
    const current = loaded(store, h);
    expect(current.accounts.map((account) => account.brokerName)).toEqual(["XTB", "XTB"]);
    expect(current.config).toBe(h.strategy.config);
    expect(current.txns).toHaveLength(4);
    expect(current.txns.some((row) => row.tradeDate === "2026-11-10")).toBe(true);
    expect(
      current.snapshot.holdings.reduce((sum, row) => sum.add(row.quantity), D("0")).toString(),
    ).toBe("3");
    expect(current.valued.totalBase.toString()).toBe("116");
    const before = loaded(store, h, { asOf: "2026-09-30" });
    expect(before.txns).toHaveLength(4);
    expect(before.snapshot.holdings).toEqual([]);
    expect(before.valued.totalBase.toString()).toBe("100");
    const filtered = loaded(store, h, { accounts: [asAccountId(h.accountA)] });
    expect(filtered.snapshot.holdings).toHaveLength(2);
    expect(filtered.valued.valued).toHaveLength(1);
    expect(filtered.valued.totalBase.toString()).toBe("104");
    expect(loaded(store, h, { accounts: [] }).valued.totalBase.toString()).toBe("0");
    store.close();
  });

  it("resolves account members and refuses another vault's account, instrument and explicit vault", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    const alias = ulid(999);
    const key = "ext:xtb:synthetic-alias";
    store.applyEnvelopes([
      h.ev.make("account.identified", h.accountA, { keys: [key] }),
      account(h.ev, alias, [key]),
    ]);
    expect(loaded(store, h, { accounts: [asAccountId(alias)] }).accountFilter).toEqual([
      h.accountA,
    ]);
    const foreign = otherVault();
    const foreignAccount = brokerage(foreign, "Synthetic foreign");
    const foreignInstrument = stock(foreign, "FOREIGN", "PL0000000999");
    const request = {
      vault: h.vault,
      asOf: "2026-10-31",
      prices: h.prices,
      strategy: h.strategy,
      lang: "en" as const,
    };
    expect(
      portfolioAt(store.read.bind(store), { ...request, accounts: [asAccountId(foreignAccount)] }),
    ).toEqual({ ok: false, reason: "unknown_account" });
    expect(
      portfolioAt(store.read.bind(store), {
        ...request,
        instrumentIds: [asInstrumentId(foreignInstrument)],
      }),
    ).toEqual({ ok: false, reason: "unknown_instrument" });
    expect(
      portfolioAt(store.read.bind(store), {
        ...request,
        vault: asProfileId("0b7e2c4d9a1f43e8b6c5d7e8f9a0b1c2"),
      }),
    ).toEqual({ ok: false, reason: "invalid_identity" });
    expect(() =>
      readFacts(foreign.store.read.bind(foreign.store), {
        portfolio: loaded(store, h),
        clock: clock(),
      }),
    ).toThrow("invalid portfolio identity");
    store.close();
    foreign.store.close();
  });

  it("keeps old chart bars while default valuation uses the Python 800-day window", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    const prices = new market.InMemoryPriceCache();
    prices.upsertBars(
      market.marketSymbol("yahoo", "AAA.WA"),
      [cachedClose("2020-01-01", "77")],
      parseDateTime(HOUSEHOLD_NOW),
    );
    const normal = loaded(store, h, { prices });
    const all = loaded(store, h, { prices, historyDays: null });
    expect(normal.historyBars.get(asInstrumentId(h.first))?.[0]?.close.toString()).toBe("77");
    expect(normal.market.bars.get(asInstrumentId(h.first))).toEqual([]);
    expect([...normal.market.instruments.keys()]).toEqual([h.first]);
    expect(normal.valued.valued[0]?.priceDate).not.toBe(all.valued.valued[0]?.priceDate);
    expect(normal.valued.valued[0]?.marketValueBase?.toString()).not.toBe(
      all.valued.valued[0]?.marketValueBase?.toString(),
    );
    const parsed = loadStrategy(`version: 1
base_currency: PLN
rules:
  - id: drawdown
    kind: drawdown_from_high
    params: {threshold: 0.1, window_days: 2}
`);
    if (parsed.config === null) throw new Error("synthetic drawdown strategy did not parse");
    const ruleConfig = parsed.config;
    const engine = new RulesEngine(ruleConfig.rules);
    const evaluate = (state: typeof normal) =>
      engine.evaluate(
        buildRuleContext({
          profileId: state.vault,
          asOf: state.asOf,
          portfolio: state.valued,
          market: state.market,
          allocation: state.allocation,
          data: ruleConfig.data,
          lang: "en",
        }),
      );
    expect(evaluate(normal)[0]).toMatchObject({ type: "skipped", reason: "No prices: AAA" });
    expect(evaluate(all)[0]).not.toEqual(evaluate(normal)[0]);
    store.close();
  });

  it("held and watched subjects receive hints; a removed-watch saved subject receives freshness only", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    for (const [index, instrument] of [h.watched, h.saved].entries()) {
      const alert = ulid(950 + index);
      store.applyEnvelopes([
        h.ev.make("alert.created", alert, {
          instrument,
          scope: "instrument",
          kind: "price_above",
          params: { level: 10 },
        }),
        h.ev.make("alert.evaluated", alert, { triggered: true, lastTriggeredAt: HOUSEHOLD_NOW }),
      ]);
    }
    const result = readAnnotations(store.read.bind(store), {
      portfolio: loaded(store, h),
      clock: clock(),
      lang: "en",
    });
    expect(
      result.facts.subjects
        .filter((subject) => subject.hintsWanted)
        .map((subject) => subject.instrument.id)
        .sort(),
    ).toEqual([h.first, h.watched].sort());
    for (const id of [h.first, h.watched])
      expect(result.annotations.get(asInstrumentId(id))?.hints.length).toBeGreaterThan(0);
    expect(result.annotations.get(asInstrumentId(h.saved))?.hints).toEqual([]);
    expect(result.annotations.get(asInstrumentId(h.saved))?.freshness).not.toBeNull();
    store.close();
  });

  it("recomputes at clock-only +1 microsecond without changing store or price versions", () => {
    const h = household();
    const store = openTestStore();
    store.applyEnvelopes(h.events);
    const portfolio = loaded(store, h);
    const before = viewHash(store).hash;
    const version = h.prices.version();
    const boundary = clock("2026-10-31T12:00:00Z");
    const first = readAnnotations(store.read.bind(store), {
      portfolio,
      clock: boundary,
      lang: "en",
    });
    const later = readAnnotations(store.read.bind(store), {
      portfolio,
      clock: { ...boundary, now: addMicroseconds(boundary.now, 1) },
      lang: "en",
    });
    expect(first.annotations.get(asInstrumentId(h.saved))?.freshness).not.toEqual(
      later.annotations.get(asInstrumentId(h.saved))?.freshness,
    );
    expect(viewHash(store).hash).toBe(before);
    expect(h.prices.version()).toBe(version);
    store.close();
  });

  it("returns equal ordered portable and annotation facts after shuffled duplicate delivery and rebuild", () => {
    const h = household();
    assertOrderedDelivery(h.events, (store) => {
      const portfolio = loaded(store, h);
      const { annotations, facts } = readAnnotations(store.read.bind(store), {
        portfolio,
        clock: clock(),
        lang: "en",
      });
      return {
        accounts: portfolio.accounts,
        txns: portfolio.txns,
        holdings: portfolio.snapshot.holdings,
        total: portfolio.valued.totalBase.toString(),
        annotations: [...annotations],
        subjects: facts.subjects,
      };
    });
  });
});
