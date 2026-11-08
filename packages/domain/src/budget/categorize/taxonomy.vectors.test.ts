import { describe, it } from "vitest";
import { builtinRegistry, textRules } from "../../core/index.js";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { normalizeText } from "../../text.js";
import { merchantKey } from "../ingestion/index.js";
import { applySeedRules, applyTextRules } from "./taxonomy.js";
import { categorizeRows } from "./testing/vectors.js";

type SeedRow = [string, string, string | null, string, string | null];
const rows = categorizeRows<SeedRow>("seed");
const MODULE_RULES = textRules(builtinRegistry());

describe("seed and text rules equal Python (budget-categorize-seed)", () => {
  it("every row: merchant key, seed category, normalized text, text rule", () => {
    const m = new Mismatches();
    for (const [i, [raw, mk, seed, text, phrase]] of rows.entries()) {
      m.check(`#${i} mk`, merchantKey(raw), mk);
      m.check(`#${i} seed`, applySeedRules(mk), seed);
      m.check(`#${i} text`, normalizeText(raw), text);
      m.check(`#${i} phrase`, applyTextRules(text, MODULE_RULES), phrase);
    }
    expectAll(m);
  });
});
