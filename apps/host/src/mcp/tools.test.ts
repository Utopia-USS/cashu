import {
  budgetTools,
  connectorTools,
  coreTools,
  investmentTools,
  investmentWriteTools,
  loansTools,
  researchTools,
} from "@cashu/mcp";
import { expect, it } from "vitest";
import { TOOL_INVENTORY } from "./tools.js";

it("assigns every canonical MCP descriptor to one native handler", () => {
  const names = [
    ...coreTools(),
    ...budgetTools(),
    ...loansTools(),
    ...investmentTools(),
    ...researchTools(),
    ...investmentWriteTools(),
    ...connectorTools(),
  ].map((tool) => tool.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names.sort()).toEqual(TOOL_INVENTORY.map((entry) => entry.name).sort());
  expect(names).toHaveLength(46);
});
