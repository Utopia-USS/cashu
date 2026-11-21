// Python test_rules_engine.py and test_rules_polarity.py: real runtime classes, isolation and order.
import { expect, it } from "vitest";
import { BUILT_IN_KINDS, RuleCatalog } from "./catalog.js";
import { RulesEngine } from "./engine.js";
import type { RuleKind } from "./kind.js";
import { CashLevelParams, cashLevelRule } from "./kinds/cashLevel.js";
import { ContributionGapParams } from "./kinds/contributionGap.js";
import { DrawdownFromHighParams } from "./kinds/drawdownFromHigh.js";
import { PositionConcentrationParams } from "./kinds/positionConcentration.js";
import { UnrealizedThresholdParams } from "./kinds/unrealizedFromCost.js";
import {
  candidate,
  Fired,
  NotFired,
  outcomeScope,
  type RuleOutcome,
  Skipped,
  signalDedupKey,
} from "./outcomes.js";
import { SignalPolarity } from "./polarity.js";
import { describe, fired, skipped, spec } from "./testing/evaluate.js";
import { ACCOUNT_A, context, d, day, h, instrument, portfolio } from "./testing/fixtures.js";

const stock = instrument("PKN");
const ctx = context({
  portfolioValue: portfolio([h(stock, { value: "9000", cost: "10000" })], {
    cash: "1000",
    deposits: [day("2026-09-30")],
  }),
  contributions: { monthlyAmount: d("1000"), dayOfMonth: null },
});
it("preserves built-in order and rejects duplicate registration", () => {
  const catalog = RuleCatalog.builtIn();
  expect(catalog.kinds).toEqual(BUILT_IN_KINDS);
  expect(() => catalog.register(cashLevelRule)).toThrow("already registered");
  expect(catalog.get("missing")).toBeNull();
});
it("evaluates every configured rule in order", () => {
  const outcomes = new RulesEngine([
    spec(
      "position_concentration",
      new PositionConcentrationParams({ maxWeight: 0.5 }),
      "concentration",
    ),
    spec("cash_level", new CashLevelParams({ maxWeight: 0.05 }), "cash"),
    spec("contribution_gap", new ContributionGapParams(), "deposits"),
    spec("loss_from_cost", new UnrealizedThresholdParams({ threshold: 0.05 }), "loss"),
  ]).evaluate(ctx);
  expect(describe(outcomes)).toEqual([
    "fired concentration|i:i-PKN",
    "fired cash",
    "not_fired deposits",
    "fired loss|i:i-PKN",
  ]);
});
class TestParams {}
it("isolates unknown kinds, plain/wrong classes, partial throws and foreign outcomes", () => {
  const catalog = RuleCatalog.builtIn();
  const base: RuleKind<TestParams> = {
    kind: "broken",
    paramsType: TestParams,
    defaultPolarity: SignalPolarity.NEUTRAL,
    parseParams: () => new TestParams(),
    *evaluate(_ctx, rule): Iterable<RuleOutcome> {
      yield new Fired(candidate(rule, rule.id, "partial", {}));
      const error = new Error("boom");
      error.name = "RuntimeError";
      throw error;
    },
  };
  catalog.register(base);
  catalog.register({ ...base, kind: "foreign", evaluate: () => [new NotFired("someone_else")] });
  const outcomes = new RulesEngine(
    [
      spec("missing", null, "unknown"),
      spec("cash_level", "bad", "wrong"),
      spec("cash_level", { minWeight: null, maxWeight: 0.05 }, "plain"),
      spec("broken", new TestParams(), "broken"),
      spec("foreign", new TestParams(), "foreign"),
      spec("cash_level", new CashLevelParams({ maxWeight: 0.05 }), "cash"),
    ],
    catalog,
  ).evaluate(ctx);
  expect(describe(outcomes)).toEqual([
    "skipped unknown",
    "skipped wrong",
    "skipped plain",
    "skipped broken",
    "skipped foreign",
    "fired cash",
  ]);
  expect(skipped(outcomes[0])).toBe('Unknown rule kind "missing"');
  expect(skipped(outcomes[1])).toBe(
    "Rule params have the wrong type (str, expected CashLevelParams)",
  );
  expect(skipped(outcomes[2])).toBe(
    "Rule params have the wrong type (dict, expected CashLevelParams)",
  );
  expect(skipped(outcomes[3])).toBe("Rule failed: RuntimeError: boom");
  expect(skipped(outcomes[4])).toBe('Rule returned an outcome for rule "someone_else"');
  expect(outcomes.filter((o) => o instanceof Skipped).every((o) => o.dedupKey === null)).toBe(true);
});
it("an empty instrument scope becomes one whole-rule NotFired", () => {
  expect(
    new RulesEngine([
      spec("drawdown_from_high", new DrawdownFromHighParams({ threshold: 0.2 }), "dips"),
    ]).evaluate(context()),
  ).toEqual([new NotFired("dips", null, { scopes: 0 })]);
});
it("stamps each kind default and explicit override without altering conditions", () => {
  const expected = [
    "neutral",
    "negative",
    "negative",
    "positive",
    "positive",
    "negative",
    "negative",
    "negative",
    "neutral",
  ];
  expect(BUILT_IN_KINDS.map((kind) => RuleCatalog.builtIn().get(kind)?.defaultPolarity)).toEqual(
    expected,
  );
  const rule = spec("cash_level", new CashLevelParams({ maxWeight: 0.05 }));
  expect(fired(new RulesEngine([rule]).evaluate(ctx)[0]).polarity).toBe("negative");
  expect(
    fired(new RulesEngine([{ ...rule, polarity: SignalPolarity.POSITIVE }]).evaluate(ctx)[0])
      .polarity,
  ).toBe("positive");
  const params = new UnrealizedThresholdParams({ threshold: 0.05 });
  expect(new RulesEngine([spec("gain_from_cost", params)]).evaluate(ctx)[0]).toBeInstanceOf(
    NotFired,
  );
});
it("canonical dedup keys keep scope identity and whole-rule null", () => {
  const key = signalDedupKey("r", {
    instrumentId: stock.id,
    accountId: ACCOUNT_A,
    scope: "bucket",
  });
  expect(key).toBe("r|i:i-PKN|a:account-a|s:bucket");
  expect(outcomeScope(new NotFired("r"))).toBeNull();
  expect(outcomeScope(new Fired(candidate(spec("custom", null), key, "", {})))).toBe(key);
});
