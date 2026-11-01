import type { ToolMetadata } from "../registry.js";
import { budgetTools } from "../tools/budget.js";
import { coreTools } from "../tools/core.js";
import { loansTools } from "../tools/loans.js";
import { DELEGATED_TOOLS, TOOL_ORDER } from "./delegated.generated.js";

export type { ToolMetadata } from "../registry.js";

/** Native specs own migrated entries; the remaining contracts describe actual Python delegation. */
export function mcpToolMetadata(): readonly ToolMetadata[] {
  const entries = [
    ...[...coreTools(), ...budgetTools(), ...loansTools()].map(
      ({ handler: _handler, ...metadata }) => metadata,
    ),
    ...DELEGATED_TOOLS,
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
