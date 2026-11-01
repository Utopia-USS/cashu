import { describe, it } from "vitest";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { checkEngine, type EngineCase } from "./testing/engineRows.js";
import { categorizeRows, ENGINE_FAST, sliceStarts } from "./testing/vectors.js";

const rows = categorizeRows<EngineCase>("engine").slice(ENGINE_FAST);
const SLICE = 500;

describe("engine equals Python (6000 random cases)", () => {
  it.each(sliceStarts(rows.length, SLICE))("cases %i..", (start) => {
    const m = new Mismatches();
    checkEngine(rows.slice(start, start + SLICE), m);
    expectAll(m);
  });
});
