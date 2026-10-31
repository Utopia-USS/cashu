/**
 * The pure half of the MCP audit log (`core/mcp/audit.py`): what a `mcp_calls` row records about a
 * call. Argument values are never stored (they may be paths, merchant names or strategy text): only
 * the declared argument names with their JSON types, and a count of unknown names (an agent-chosen
 * key could itself carry data). Writing the row (store command, per device) is the server's job.
 */

/** `started`: logged, outcome not recorded. */
export const OUTCOMES = ["ok", "error", "refused", "started"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type JsonTypeName =
  | "null"
  | "boolean"
  | "integer"
  | "number"
  | "string"
  | "array"
  | "object"
  | "other";

/**
 * The JSON type of a decoded argument value. Decoded MCP JSON has no int / float distinction in
 * JavaScript, so an integral number reports `integer` (Python's `json.loads` gives an int for `3`
 * and a float for `3.0`; both decode to the JS number 3).
 */
export function jsonType(value: unknown): JsonTypeName {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "bigint") return "integer";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "other";
}

/** `{name: json type}` for the tool's declared arguments; unknown names are only counted. */
export function summarizeArgs(
  args: Readonly<Record<string, unknown>> | null | undefined,
  known: ReadonlySet<string>,
): Record<string, JsonTypeName | number> {
  const out: Record<string, JsonTypeName | number> = {};
  let unknown = 0;
  for (const [name, value] of Object.entries(args ?? {})) {
    if (known.has(name)) out[name] = jsonType(value);
    else unknown++;
  }
  if (unknown) out._unknown = unknown;
  return out;
}

/** The stored outcome: anything outside `OUTCOMES` is recorded as `error`. */
export function storedOutcome(outcome: string): Outcome {
  return (OUTCOMES as readonly string[]).includes(outcome) ? (outcome as Outcome) : "error";
}

/** The stored tool name (at most 80 characters, as the Python column). */
export function storedTool(tool: string): string {
  return Array.from(tool).slice(0, 80).join("");
}

/** The stored duration: whole milliseconds, never negative. */
export function storedDuration(durationMs: number): number {
  return Math.max(0, Math.trunc(durationMs));
}
