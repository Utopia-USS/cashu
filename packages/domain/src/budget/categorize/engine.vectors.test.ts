import { describe, it } from "vitest";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { checkEngine, type EngineCase } from "./testing/engineRows.js";
import { categorizeRows, ENGINE_FAST } from "./testing/vectors.js";

describe("engine equals Python (budget-categorize-engine, fast slice)", () => {
  it("first cases: owner_decision and categorize", () => {
    const m = new Mismatches();
    checkEngine(categorizeRows<EngineCase>("engine").slice(0, ENGINE_FAST), m);
    expectAll(m);
  });
});
