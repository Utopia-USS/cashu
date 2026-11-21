import type { ToolMetadata } from "../registry.js";
import { budgetTools } from "../tools/budget.js";
import { coreTools } from "../tools/core.js";
import { investmentTools } from "../tools/investments.js";
import { loansTools } from "../tools/loans.js";
import { NATIVE_TOOL_SCHEMAS, TOOL_ORDER } from "./toolSchemas.js";

export type { ToolMetadata } from "../registry.js";

/** Native specs own migrated entries; retained source schemas cover the remaining native tools. */
export function mcpToolMetadata(): readonly ToolMetadata[] {
  const entries = [
    ...[...coreTools(), ...budgetTools(), ...loansTools(), ...investmentTools()].map(
      ({ handler: _handler, ...metadata }) => metadata,
    ),
    ...NATIVE_TOOL_SCHEMAS,
  ];
  const byName = new Map(entries.map((tool) => [tool.name, tool]));
  if (byName.size !== entries.length || byName.size !== TOOL_ORDER.length)
    throw new Error("MCP metadata coverage is inconsistent");
  return TOOL_ORDER.map((name) => {
    const metadata = byName.get(name);
    if (metadata === undefined) throw new Error("MCP metadata is missing a registered tool");
    return metadata;
  });
}
