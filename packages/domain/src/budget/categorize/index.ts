/** Public API of the budget categorization sub-folder (Python `modules/budget/categorize`). */

export {
  type CloudMerchant,
  type CloudRow,
  cloudMerchants,
  hasP2pMarker,
  P2P_MARKERS,
} from "./cloudGate.js";
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
export type {
  Answer,
  ClassifierFailure,
  MerchantClassifier,
  TransactionClassifier,
} from "./llm/port.js";
export {
  ANTHROPIC_MERCHANT_PREFIX,
  anthropicSystemText,
  OLLAMA_MERCHANT_PREFIX,
  OLLAMA_TXN_PREFIX,
  ollamaMerchantSystemPrompt,
  ollamaTxnSystemPrompt,
} from "./llm/prompts.js";
export {
  type BatchResult,
  parseAnthropicReply,
  parseOllamaMerchantReply,
  parseOllamaTxnReply,
} from "./llm/replies.js";
export {
  ANTHROPIC_BATCH_SIZE,
  ANTHROPIC_DEFAULT_MODEL,
  anthropicMerchantBatches,
  type MerchantBatch,
  OLLAMA_BATCH_SIZE,
  OLLAMA_DEFAULT_MODEL,
  ollamaMerchantBatches,
  ollamaTxnBatches,
  type TxnBatch,
} from "./llm/requests.js";
export { anthropicSchema, ollamaSchema } from "./llm/schemas.js";
export { acceptMerchantAnswer, codePointCompare, unknownMerchants } from "./llmPass.js";
export {
  applyReclassify,
  isOwnerDecided,
  isStructural,
  OWNER_SOURCES,
  planReclassify,
  RECLASSIFY_KEYS,
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
  type RecurringDates,
  type RecurringMember,
  type RecurringOptions,
  type RecurringRow,
  recurringDates,
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
