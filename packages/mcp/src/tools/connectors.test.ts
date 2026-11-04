import { expect, it } from "vitest";
import { inputSchema } from "../registry.js";
import { mcpToolMetadata } from "../runtime/metadata.js";
import { connectorTools } from "./connectors.js";

it("keeps the three frozen connector names and schemas", () => {
  const tools = connectorTools();
  expect(tools.map((tool) => tool.name)).toEqual([
    "test_connector",
    "propose_connector",
    "connectors",
  ]);
  for (const tool of tools) {
    const frozen = mcpToolMetadata().find((row) => row.name === tool.name);
    expect(frozen).toBeDefined();
    if (!frozen) throw new Error("frozen connector metadata missing");
    expect(inputSchema(tool)).toEqual(inputSchema(frozen));
    expect(tool.description).toBe(frozen?.description);
  }
});
