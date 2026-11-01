import { describe, expect, it } from "vitest";
import { AUTO_CATEGORY_KEYS, categoryLabel, STRUCTURAL_CATEGORIES } from "../taxonomy.js";
import { loadMatchingData } from "../testing/vectors.js";
import {
  ANTHROPIC_MERCHANT_PREFIX,
  anthropicSystemText,
  ollamaMerchantSystemPrompt,
  ollamaTxnSystemPrompt,
} from "./prompts.js";
import {
  ANTHROPIC_BATCH_SIZE,
  ANTHROPIC_DEFAULT_MODEL,
  OLLAMA_BATCH_SIZE,
  OLLAMA_DEFAULT_MODEL,
} from "./requests.js";
import { anthropicSchema, ollamaSchema } from "./schemas.js";

const { data } = loadMatchingData();
const allowed = AUTO_CATEGORY_KEYS.filter((k) => !STRUCTURAL_CATEGORIES.has(k));
const labels = new Map(allowed.map((k) => [k, categoryLabel(k)]));

describe("LLM prompts are byte-identical to Python (matching data)", () => {
  it("the three system prompts", () => {
    expect(ollamaMerchantSystemPrompt(AUTO_CATEGORY_KEYS)).toBe(data.ollamaMerchantSystem);
    expect(ollamaTxnSystemPrompt(labels)).toBe(data.ollamaTxnSystem);
    expect([
      {
        type: "text",
        text: anthropicSystemText(AUTO_CATEGORY_KEYS),
        cache_control: { type: "ephemeral" },
      },
    ]).toEqual(data.anthropicSystem);
  });

  it("the schemas, the user prefix and the reclassify enum", () => {
    expect(ollamaSchema(AUTO_CATEGORY_KEYS)).toEqual(data.ollamaSchema);
    expect(anthropicSchema(AUTO_CATEGORY_KEYS)).toEqual(data.anthropicSchema);
    expect(ANTHROPIC_MERCHANT_PREFIX).toBe(data.anthropicUserPrefix);
    expect(allowed).toEqual(data.reclassifyAllowed);
  });

  it("models and batch sizes are Python's defaults", () => {
    expect([
      OLLAMA_DEFAULT_MODEL,
      OLLAMA_BATCH_SIZE,
      ANTHROPIC_DEFAULT_MODEL,
      ANTHROPIC_BATCH_SIZE,
    ]).toEqual([
      data.defaults.ollamaModel,
      data.defaults.ollamaBatch,
      data.defaults.anthropicModel,
      data.defaults.anthropicBatch,
    ]);
    expect(data.defaults.ollamaTxnBatch).toBe(OLLAMA_BATCH_SIZE);
    expect([
      data.defaults.settingsModel,
      data.defaults.settingsOllamaModel,
      data.defaults.settingsBackend,
    ]).toEqual([ANTHROPIC_DEFAULT_MODEL, OLLAMA_DEFAULT_MODEL, "ollama"]);
  });

  it("prompts are NFC; the only non-Polish non-ASCII character is U+2014 (built from its code point)", () => {
    for (const p of [
      data.ollamaMerchantSystem,
      data.ollamaTxnSystem,
      anthropicSystemText(AUTO_CATEGORY_KEYS),
    ]) {
      expect(p.normalize("NFC")).toBe(p);
      const odd = [...p].filter(
        (ch) => ch > "\u007f" && !`ąćęłńóśźżĄĆĘŁŃÓŚŹŻ${String.fromCodePoint(0x2014)}`.includes(ch),
      );
      expect(odd).toEqual([]);
    }
  });
});
