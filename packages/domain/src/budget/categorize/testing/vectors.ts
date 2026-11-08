/** Readers of the S09 vectors (the retired Python `vectors_budget_categorize.py`), tests only. */
import { loadVectors } from "../../../testing/vectors.js";

export interface MatchingData {
  readonly categories: readonly [string, string, string][];
  readonly labelsEn: Readonly<Record<string, string>>;
  readonly manualOnly: readonly string[];
  readonly autoCategoryKeys: readonly string[];
  readonly seedRules: readonly [string, string, boolean][];
  readonly textRules: readonly [string, string][];
  readonly moduleTextRules: readonly [string, string][];
  readonly notSubscription: readonly string[];
  readonly moduleNotSubscription: readonly string[];
  readonly txnDecidedSources: readonly string[];
  readonly ownerSources: readonly string[];
  readonly structuralCategories: readonly string[];
  readonly keepOnMerchantPin: readonly string[];
  readonly reclassifyRegexes: Readonly<Record<string, [string, number]>>;
  readonly engineLiterals: readonly string[];
  readonly contextLiterals: readonly string[];
  readonly ollamaMerchantSystem: string;
  readonly ollamaTxnSystem: string;
  readonly anthropicSystem: unknown;
  readonly ollamaSchema: unknown;
  readonly anthropicSchema: unknown;
  readonly anthropicUserPrefix: string;
  readonly reclassifyAllowed: readonly string[];
  readonly defaults: Readonly<Record<string, string | number>>;
  readonly sharedBodies: Readonly<Record<string, unknown>>;
  readonly unidataVersion: string;
}

/** `budget-categorize-matching-data.jsonl`: the live Python data and its sha256 as written. */
export function loadMatchingData(): { data: MatchingData; sha256: string } {
  const [[row]] = loadVectors("budget-categorize-matching-data").rows as [
    [{ data: MatchingData; sha256: string }],
  ];
  return row;
}

/** The rows of one `budget-categorize-<name>.jsonl` file. */
export function categorizeRows<T>(name: "seed" | "engine" | "all" | "llm" | "reclassify"): T[] {
  return loadVectors(`budget-categorize-${name}`).rows as T[];
}

/** `OWN_IBANS_RAW` of the generator (synthetic): the own accounts of every engine case. */
export const ENGINE_OWN_IBANS: readonly string[] = [
  "PL61 1090 1014 0000 0712 1981 2874",
  "99 1000 0000 0000 0000 0000 0001",
  "DE89370400440532013000",
];
