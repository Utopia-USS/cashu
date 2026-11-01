import { describe, expect, it } from "vitest";
import { builtinRegistry, textRules } from "../../core/index.js";
import { sha256Hex } from "../../sha256.js";
import {
  AUTO_CATEGORY_KEYS,
  applySeedRules,
  applyTextRules,
  CATEGORIES,
  CATEGORY_KEYS,
  categoryLabel,
  INCOME_KEYS,
  isCategoryKey,
  MANUAL_ONLY,
  SEED_RULES,
  STRUCTURAL_CATEGORIES,
  TEXT_RULES,
} from "./taxonomy.js";
import { loadMatchingData } from "./testing/vectors.js";

const { data, sha256 } = loadMatchingData();

/** Python `json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const rec = value as Record<string, unknown>;
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("taxonomy matching data (live Python objects, budget-categorize-matching-data.json)", () => {
  it("the file's sha256 is the hash of its data (no hand edit)", () => {
    expect(sha256Hex(canonicalJson(data))).toBe(sha256);
  });

  it("categories, labels and kinds equal Python, display order kept", () => {
    expect(CATEGORIES.map((c) => [c.key, c.label, c.kind])).toEqual(data.categories);
    expect(Object.fromEntries(CATEGORIES.map((c) => [c.key, c.labelEn]))).toEqual(data.labelsEn);
    expect(CATEGORY_KEYS).toEqual(data.categories.map((c) => c[0]));
    expect([...MANUAL_ONLY].sort()).toEqual(data.manualOnly);
    expect(AUTO_CATEGORY_KEYS).toEqual(data.autoCategoryKeys);
    expect([...STRUCTURAL_CATEGORIES].sort()).toEqual(data.structuralCategories);
    expect([...INCOME_KEYS]).toEqual(["income_salary", "income_refund", "income_other"]);
  });

  it("the 426 seed rules are byte-identical, in order, with the word flags (Polish data)", () => {
    expect(SEED_RULES.map((r) => [r.needle, r.category, r.word])).toEqual(data.seedRules);
    expect(SEED_RULES).toHaveLength(426);
    expect(TEXT_RULES).toEqual(data.textRules);
    expect(textRules(builtinRegistry())).toEqual(data.moduleTextRules);
  });

  it("every needle and label is NFC (no decomposed diacritic slips in)", () => {
    for (const r of SEED_RULES) expect(r.needle.normalize("NFC")).toBe(r.needle);
    for (const c of CATEGORIES) expect(c.label.normalize("NFC")).toBe(c.label);
  });

  it("every seed rule targets a known category", () => {
    for (const r of SEED_RULES) expect(isCategoryKey(r.category), r.needle).toBe(true);
  });
});

describe("taxonomy behaviour", () => {
  it("empty input matches nothing", () => {
    expect(applySeedRules("")).toBeNull();
    expect(applyTextRules("", textRules(builtinRegistry()))).toBeNull();
  });

  it("module phrases come before the budget's own", () => {
    expect(applyTextRules("CZYNSZ RATA KREDYTU", [["RATA KREDYTU", "loans"]])).toBe("loans");
    expect(applyTextRules("CZYNSZ RATA KREDYTU", [])).toBe("housing");
  });

  it("a word needle needs a word boundary on the left and allows trailing digits", () => {
    const word = SEED_RULES.find((r) => r.word);
    expect(word).toBeDefined();
    const needle = (word as { needle: string }).needle;
    const cat = (word as { category: string }).category;
    expect(applySeedRules(`${needle}1234`)).toBe(cat);
    expect(applySeedRules(`X ${needle} Y`)).toBe(cat);
    expect(applySeedRules(`1${needle}`)).not.toBe(cat);
  });

  // PARITY(Q2): the dead rule stays verbatim.
  it("keeps the dead KUChNIA rule verbatim (PARITY Q2)", () => {
    expect(SEED_RULES.some((r) => r.needle === "KUChNIA")).toBe(true);
  });

  it("isCategoryKey and categoryLabel", () => {
    expect(isCategoryKey("groceries")).toBe(true);
    expect(isCategoryKey("Groceries")).toBe(false);
    expect(categoryLabel("travel")).toBe("Podróże");
    expect(categoryLabel("nope")).toBe("nope");
  });
});
