/** Owner-rule hint tables: which hints a held or watched instrument gets, in which order. */
import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import { Freshness } from "./freshness.js";
import { type HintFacts, hintNumber, instrumentHints } from "./hints.js";

const held = (over: Partial<HintFacts> = {}): HintFacts => ({
  held: true,
  health: "current",
  hasThesis: true,
  hasExitPlan: true,
  plan: null,
  ...over,
});
const codes = (f: HintFacts) => instrumentHints(f).map((h) => h.code);
const stale = (state: "outdated" | "maybe_outdated") =>
  new Freshness(state, [{ code: state === "outdated" ? "note_invalidates" : "age", at: null }]);

describe("held hints", () => {
  it("orders freshness, thesis, contradiction and rule hints by the held table", () => {
    const f = held({
      health: "invalidated",
      plan: "buy",
      freshness: stale("outdated"),
      signals: [
        { kind: "position_concentration", payload: { weight: 0.31, max_weight: 0.25 } },
        { kind: "loss_from_cost", payload: { unrealized_pct: -0.4, threshold: 0.3 } },
      ],
    });
    expect(instrumentHints(f).map((h) => [h.code, h.severity])).toEqual([
      ["recommendation_outdated", "rule"],
      ["thesis_invalidated", "rule"],
      ["plan_vs_thesis", "rule"],
      ["loss_review", "review"],
      ["concentration", "review"],
    ]);
    const loss = instrumentHints(f).find((h) => h.code === "loss_review");
    expect(loss?.params).toEqual({ loss: 0.4, threshold: 0.3 });
  });

  it("keeps the strongest signal of a kind by threshold", () => {
    const [gain] = instrumentHints(
      held({
        signals: [
          { kind: "gain_from_cost", payload: { unrealized_pct: 1.2, threshold: 0.5 } },
          { kind: "gain_from_cost", payload: { unrealized_pct: 1.2, threshold: "1.0" } },
          { kind: "gain_from_cost", payload: { unrealized_pct: 1.2, threshold: "junk" } },
        ],
      }),
    );
    expect(gain).toEqual({
      code: "gain_review",
      severity: "review",
      params: { gain: 1.2, threshold: 1, has_exit_plan: true },
    });
  });

  it("asks for a thesis first, then for an exit plan unless fulfilled or a gain review covers it", () => {
    expect(codes(held({ hasThesis: false, hasExitPlan: false }))).toEqual(["no_thesis"]);
    expect(codes(held({ hasExitPlan: false }))).toEqual(["no_exit_plan"]);
    expect(codes(held({ hasExitPlan: false, health: "fulfilled" }))).toEqual(["thesis_fulfilled"]);
    expect(
      codes(
        held({
          hasExitPlan: false,
          signals: [{ kind: "gain_from_cost", payload: { unrealized_pct: 2, threshold: 1 } }],
        }),
      ),
    ).toEqual(["gain_review"]);
  });

  it("flags a weak position after thesis_fulfilled, keeps it without a tracked thesis", () => {
    const weak = held({
      health: "fulfilled",
      hasExitPlan: false,
      positionStrength: "weak",
      strengthBasis: "fulfilled",
      signals: [{ kind: "loss_from_cost", payload: { unrealized_pct: -0.4, threshold: 0.3 } }],
    });
    expect(instrumentHints(weak).map((h) => [h.code, h.severity])).toEqual([
      ["thesis_fulfilled", "review"],
      ["position_weak", "review"],
      ["loss_review", "review"],
    ]);
    expect(instrumentHints(weak).find((h) => h.code === "position_weak")?.params).toEqual({
      basis: "fulfilled",
      has_exit_plan: false,
    });
    // its exit-plan nudge replaces no_exit_plan
    expect(
      codes(held({ hasExitPlan: false, positionStrength: "weak", strengthBasis: "undermined" })),
    ).toEqual(["position_weak"]);
    expect(codes(held({ positionStrength: "neutral", strengthBasis: "no_progress" }))).toEqual([]);
    // the agent's assessment, not a thesis code: kept when no thesis is tracked
    expect(
      codes(
        held({
          hasThesis: false,
          thesisTracked: false,
          positionStrength: "weak",
          strengthBasis: "environment_against",
        }),
      ),
    ).toEqual(["position_weak"]);
    // never a watched hint
    expect(
      codes({ ...held({ positionStrength: "weak", strengthBasis: "undermined" }), held: false }),
    ).toEqual([]);
  });

  it("drops thesis hints when the owner does not track a thesis for the instrument", () => {
    expect(
      codes(held({ hasThesis: false, health: "weakened", thesisTracked: false, freshness: null })),
    ).toEqual([]);
    expect(codes(held({ health: "weakened", thesisTracked: false }))).toEqual(["thesis_weakened"]);
  });
});

describe("watched hints", () => {
  it("lists triggered alerts in creation order, then freshness and the buy-without-thesis rule", () => {
    const hints = instrumentHints({
      held: false,
      health: "no_thesis",
      hasThesis: false,
      plan: "buy",
      freshness: stale("maybe_outdated"),
      alerts: [
        { alertId: "a2", kind: "price_below", title: null, order: 2 },
        { alertId: "a1", kind: "price_above", title: "Breakout", order: 1 },
      ],
    });
    expect(hints.map((h) => [h.code, h.severity])).toEqual([
      ["recommendation_maybe_outdated", "review"],
      ["alert_triggered", "review"],
      ["alert_triggered", "review"],
      ["plan_without_thesis", "rule"],
      ["no_thesis", "info"],
    ]);
    expect(hints[0]?.params).toEqual({ reasons: ["age"] });
    expect(hints.slice(1, 3).map((h) => h.params.alert_id)).toEqual(["a1", "a2"]);
  });

  it("never asks a watched instrument for an exit plan", () => {
    expect(codes({ held: false, health: "current", hasThesis: true, hasExitPlan: false })).toEqual(
      [],
    );
  });
});

it("reads numeric payloads like Python float() and rounds to 4 places, null when malformed", () => {
  expect(hintNumber(D("0.123456"))).toBe(0.1235);
  expect(hintNumber(" 0.5 ")).toBe(0.5);
  expect(hintNumber(true)).toBeNull();
  expect(hintNumber(null)).toBeNull();
  expect(hintNumber("abc")).toBeNull();
});
