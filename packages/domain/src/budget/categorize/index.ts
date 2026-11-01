/** Public API of the budget categorization sub-folder (Python `modules/budget/categorize`). */

export {
  type CategorizeRow,
  type Categorizer,
  type CategoryClaimValue,
  type ClaimSource,
  categorizeAll,
  createCategorizer,
  type Effective,
  effectiveCategory,
} from "./effective.js";
export {
  type Categorization,
  categorize,
  type EngineContext,
  type EngineSource,
  type EngineTxn,
  ownerDecision,
  txnMerchantKey,
  txnText,
} from "./engine.js";
export { acceptMerchantAnswer, codePointCompare, unknownMerchants } from "./llmPass.js";
export {
  applyReclassify,
  isOwnerDecided,
  isStructural,
  OWNER_SOURCES,
  planReclassify,
  RECLASSIFY_PATTERNS,
  type ReclassifyGroup,
  type ReclassifyOptions,
  type ReclassifyPlan,
  type ReclassifyRow,
  signCorrect,
  txnContext,
  txnSignature,
} from "./reclassify.js";
export {
  detectRecurring,
  NOT_SUBSCRIPTION_CATEGORIES,
  type RecurringCandidate,
  type RecurringOptions,
  type RecurringRow,
  subscriptionPayees,
  TXN_DECIDED_SOURCES,
} from "./recurring.js";
export { type MerchantRule, type RuleSource, rulesByMerchant, ruleUpsert } from "./rules.js";
export {
  AUTO_CATEGORY_KEYS,
  applySeedRules,
  applyTextRules,
  CATEGORIES,
  CATEGORY_KEYS,
  type Category,
  type CategoryKind,
  categoryLabel,
  INCOME_KEYS,
  isCategoryKey,
  MANUAL_ONLY,
  SEED_RULES,
  type SeedRule,
  STRUCTURAL_CATEGORIES,
  TEXT_RULES,
} from "./taxonomy.js";
