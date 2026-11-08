import { describe, it } from "vitest";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { checkEngine, type EngineCase } from "./testing/engineRows.js";
import { categorizeRows } from "./testing/vectors.js";

describe("engine equals Python (budget-categorize-engine)", () => {
  it("every case: owner_decision and categorize", () => {
    const m = new Mismatches();
    checkEngine(categorizeRows<EngineCase>("engine"), m);
    expectAll(m);
  });
});
