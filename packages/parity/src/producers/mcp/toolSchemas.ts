/** The actual mixed registry: native specs plus the declared contracts still delegated to Python. */
import {
  enabledIn,
  INSTRUCTIONS,
  inputSchema,
  listedModule,
  mcpToolMetadata,
  PROVIDERS,
} from "@cashu/mcp";
import { mcpProfile } from "@cashu/store/core";
import type { PythonDb } from "../../sources/index.ts";
import { type OutValue, pyFloat } from "../output.ts";
import { genesisRun } from "../store/genesisRun.ts";

/** Schema numbers are constraints, never financial values. Preserve their JSON numeric kind. */
function schemaValue(value: unknown): OutValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : pyFloat(value);
  if (Array.isArray(value)) return value.map(schemaValue);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, schemaValue(child)]),
    );
  throw new Error("non-JSON MCP registry metadata");
}

export function produceMcpToolSchemas(db: PythonDb): OutValue {
  const tools = mcpToolMetadata();
  const vaults = genesisRun(db).vaults;
  const listed: Record<string, OutValue> = {};
  for (const profile of db.profiles()) {
    const vault = vaults.get(profile.id);
    if (vault === undefined) throw new Error("MCP schema parity: missing genesis vault");
    const native = mcpProfile(vault.store.read.bind(vault.store));
    if (native === undefined) throw new Error("MCP schema parity: missing native profile");
    const enabled = new Set(native.modules);
    listed[db.keys.key("profiles", profile.id)] = tools
      .filter((tool) => enabledIn(tool, enabled))
      .map((tool) => ({ name: tool.name, listed_module: listedModule(tool, enabled) }));
  }
  return {
    instructions: INSTRUCTIONS,
    // The oracle records Python import paths; retain its external names for the same provider order.
    providers: PROVIDERS.map((provider) => `cashu.core.mcp.tools.${provider}`),
    tools: tools.map((tool) => ({
      name: tool.name,
      module: tool.module,
      also: tool.also,
      write: tool.write,
      description: tool.description,
      input_schema: schemaValue(inputSchema(tool)),
      annotations: {
        read_only_hint: !tool.write,
        destructive_hint: false,
        open_world_hint: false,
      },
      refused: tool.refused,
      refused_values: tool.refusedValues,
      nullable: tool.nullable,
    })),
    listed,
  };
}
