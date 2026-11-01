import type { ToolMetadata } from "../registry.js";
import { coreTools } from "../tools/core.js";
import { DELEGATED_TOOLS } from "./delegated.generated.js";

export type { ToolMetadata } from "../registry.js";

/** Native specs own migrated entries; the remaining contracts describe actual Python delegation. */
export function mcpToolMetadata(): readonly ToolMetadata[] {
  return [...coreTools().map(({ handler: _handler, ...metadata }) => metadata), ...DELEGATED_TOOLS];
}
