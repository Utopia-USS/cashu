/** The MCP privacy layer: labelled trees, redaction by privacy level, text scrubbing, the name guard. */

export { accountLabels, type LabelledAccount } from "./accounts.js";
export {
  type JsonTypeName,
  jsonType,
  OUTCOMES,
  type Outcome,
  storedDuration,
  storedOutcome,
  storedTool,
  summarizeArgs,
} from "./audit.js";
export {
  AMOUNT_PLACEHOLDER,
  amountLiterals,
  type ExprDeps,
  type ExprNode,
  type ExprUnit,
  type LiteralOptions,
  scrubAmountLiterals,
} from "./exprLiterals.js";
export {
  account,
  amount,
  COMPACT_FROM,
  category,
  compactNumber,
  count,
  date,
  flag,
  identifier,
  Labelled,
  type LabelledTree,
  type LeafValue,
  level,
  MARKET_LABELS,
  market,
  marketOk,
  merchant,
  NO_SUMMARIES,
  pct,
  ref,
  SENSITIVITIES,
  type Sensitivity,
  type SummaryCheck,
  share,
  symbol,
  text,
} from "./labels.js";
export {
  customCondition,
  customSignalMessage,
  type PrivacyContext,
  scrubNumbers,
  systemText,
} from "./messages.js";
export {
  AMBIGUOUS_MARKERS,
  BUSINESS_MARKERS,
  type CollectInput,
  collectGuard,
  fold,
  isPayeeRef,
  looksLikePerson,
  NameGuard,
  type NameGuardInit,
  type NameSources,
  nameTerms,
  normalize,
  personPart,
  REF_PREFIX,
  type SecretSource,
} from "./names.js";
export { loadPayeeSecret } from "./payeeSecret.js";
export { type DumpOptions, type JsonValue, pyDumps } from "./pyJson.js";
export {
  AMOUNTS,
  type LeakCheckOptions,
  LeakDetected,
  leakCheck,
  MONEY_KEYS,
  type Privacy,
  Redactor,
  type RedactorOptions,
  STRICT,
  UnlabelledValue,
} from "./redactor.js";
export { isinValid, type ScrubOptions, scrubText } from "./scrub.js";
