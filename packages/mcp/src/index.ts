export const PACKAGE_NAME = "@cashu/mcp";

export * from "./privacy/index.js";
export {
  type BudgetNameRow,
  budgetNameSources,
  type InvestmentNameRow,
  investmentNameSources,
  loadAccountLabels,
  loadGuard,
  loadNameSources,
  ownerNamed,
} from "./providers/index.js";
export {
  allTools,
  enabledIn,
  inputSchema,
  listedModule,
  MAX_STRING,
  PROVIDERS,
  type PropertySchema,
  type ToolArgs,
  type ToolContext,
  type ToolContextInit,
  ToolError,
  type ToolSpec,
  type ToolSpecInit,
  toolContext,
  toolSpec,
  validateArguments,
} from "./registry.js";
export { mcpToolMetadata, type ToolMetadata } from "./runtime/metadata.js";
export { decodeEntityRef, type EntityRefKind, encodeEntityRef } from "./runtime/refs.js";
export {
  APP_UPDATED,
  type AuditPort,
  BRIDGE_CAPABILITY,
  CEILING_KEY,
  type DelegatedNameSources,
  EFFECTIVE_PRIVACY_KEY,
  failure,
  INSTRUCTIONS,
  NAME_GUARD_APPLIED_KEY,
  NAME_GUARD_KEY,
  type NativeCallResult,
  type NativeExecution,
  NativeMcpServer,
  type NativePolicy,
  type NativeRuntime,
  privacyCeiling,
  restrictivePrivacy,
  resultText,
  type ToolDescriptor,
  toolDescriptor,
} from "./runtime/server.js";
export type { NativeToolStore, ToolInventoryEntry } from "./runtime/types.js";
export { budgetTools } from "./tools/budget.js";
export { coreTools } from "./tools/core.js";
export { loansTools } from "./tools/loans.js";
