import { describe, it } from "vitest";
import { builtinRegistry, textRules } from "../../core/index.js";
import { expectAll, Mismatches } from "../../testing/vectors.js";
import { normalizeText } from "../../text.js";
import { merchantKey } from "../ingestion/index.js";
import { applySeedRules, applyTextRules } from "./taxonomy.js";
import { categorizeRows, SEED_FAST as FAST, sliceStarts } from "./testing/vectors.js";

type SeedRow = [string, string, string | null, string, string | null];
const rows = categorizeRows<SeedRow>("seed").slice(FAST);
const MODULE_RULES = textRules(builtinRegistry());
const SLICE = 800;

describe("seed and text rules equal Python (every needle x 12 variants + 4000 random)", () => {
  it.each(sliceStarts(rows.length, SLICE))("rows %i..", (start) => {
    const m = new Mismatches();
    for (const [i, [raw, mk, seed, text, phrase]] of rows.slice(start, start + SLICE).entries()) {
      const at = FAST + start + i;
      m.check(`#${at} mk`, merchantKey(raw), mk);
      m.check(`#${at} seed`, applySeedRules(mk), seed);
      m.check(`#${at} text`, normalizeText(raw), text);
      m.check(`#${at} phrase`, applyTextRules(text, MODULE_RULES), phrase);
    }
    expectAll(m);
  });
});
