/**
 * Tool specs, argument validation and the per-call context (port of `core/mcp/registry.py`).
 *
 * A tool provider (one per module: `core` = always available, otherwise the tool is listed and
 * callable only while that module is enabled for the profile) exports its `ToolSpec`s: an input
 * schema (JSON Schema, no additional properties, never a profile argument: the server serves one
 * profile) and a handler `(ctx, args) -> labelled tree`. Handlers throw `ToolError` for problems the
 * agent can fix (the message is scrubbed before it is sent). Refused arguments are arguments that do
 * not exist (any more), each with the message telling the agent what to do instead; they are not part
 * of the schema.
 */

import { floatRepr, type IsoDate, pyLen } from "@cashu/domain";
import type { LabelledTree } from "./privacy/labels.js";
import type { NameGuard } from "./privacy/names.js";
import { compareCodePoints } from "./privacy/pyJson.js";
import type { Privacy } from "./privacy/redactor.js";

/** Provider order (`registry.PROVIDERS`): tools are listed in this order, then in each provider's order. */
export const PROVIDERS = [
  "core",
  "budget",
  "loans",
  "investments",
  "alerts",
  "research",
  "connectors",
] as const;

/** Strategy YAML / markdown are the longest arguments. */
export const MAX_STRING = 200_000;

/** A problem the agent can fix (bad argument, missing data). `kind` is a fixed audit code. */
export class ToolError extends Error {
  readonly kind: string;

  constructor(message: string, kind = "invalid") {
    super(message);
    this.name = "ToolError";
    this.kind = kind;
  }
}

/** One property of a tool's input schema (JSON Schema subset the registry reads). */
export interface PropertySchema {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly [key: string]: unknown;
}

/** What a handler works with: the bound profile, the privacy level of this call and the lazily built guard. */
export interface ToolContext<Store = unknown> {
  readonly store: Store;
  readonly profileId: number | bigint;
  readonly privacy: Privacy;
  readonly today: IsoDate;
  readonly strict: boolean;
  /** The profile's name guard (built on first use, once per call). */
  readonly guard: NameGuard;
  /** Generated account labels by account id (built on first use, once per call). */
  readonly accountLabels: ReadonlyMap<number | bigint, string>;
}

export interface ToolContextInit<Store> {
  readonly store: Store;
  readonly profileId: number | bigint;
  readonly privacy: string;
  readonly today: IsoDate;
  readonly loadGuard: () => NameGuard;
  readonly loadAccountLabels: () => ReadonlyMap<number | bigint, string>;
}

/** A call's context; any privacy other than `amounts` is strict. */
export function toolContext<Store>(init: ToolContextInit<Store>): ToolContext<Store> {
  let guard: NameGuard | null = null;
  let labels: ReadonlyMap<number | bigint, string> | null = null;
  const privacy: Privacy = init.privacy === "amounts" ? "amounts" : "strict";
  return {
    store: init.store,
    profileId: init.profileId,
    privacy,
    today: init.today,
    strict: privacy === "strict",
    get guard() {
      guard ??= init.loadGuard();
      return guard;
    },
    get accountLabels() {
      labels ??= init.loadAccountLabels();
      return labels;
    },
  };
}

export type ToolArgs = Readonly<Record<string, unknown>>;

export interface ToolSpec<Store = unknown> {
  readonly name: string;
  /** `"core"` or a module id. */
  readonly module: string;
  readonly description: string;
  readonly handler: (ctx: ToolContext<Store>, args: ToolArgs) => LabelledTree;
  readonly properties: Readonly<Record<string, PropertySchema>>;
  readonly required: readonly string[];
  readonly write: boolean;
  /** Arguments that do not exist (any more), with the message telling the agent what to do instead. */
  readonly refused: Readonly<Record<string, string>>;
  /** Values of an argument outside its enum that get their own message instead of the generic enum error. */
  readonly refusedValues: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Arguments that must be given but may be an explicit null (required, typed `[<type>, "null"]`). */
  readonly nullable: readonly string[];
  /** More modules that make the tool available (any of `module` and these). */
  readonly also: readonly string[];
}

export type ToolSpecInit<Store> = Pick<
  ToolSpec<Store>,
  "name" | "module" | "description" | "handler"
> &
  Partial<Omit<ToolSpec<Store>, "name" | "module" | "description" | "handler">>;

export function toolSpec<Store>(init: ToolSpecInit<Store>): ToolSpec<Store> {
  return {
    properties: {},
    required: [],
    write: false,
    refused: {},
    refusedValues: {},
    nullable: [],
    also: [],
    ...init,
  };
}

/** Listed and callable for a profile with these modules enabled. */
export function enabledIn(spec: ToolSpec<never>, enabled: ReadonlySet<string>): boolean {
  return (
    spec.module === "core" || enabled.has(spec.module) || spec.also.some((m) => enabled.has(m))
  );
}

/** The module the tool is listed under for this profile (the first enabled one). */
export function listedModule(spec: ToolSpec<never>, enabled: ReadonlySet<string>): string {
  if (spec.module === "core" || enabled.has(spec.module)) return spec.module;
  return spec.also.find((m) => enabled.has(m)) ?? spec.module;
}

/** The JSON Schema the server lists for the tool. */
export function inputSchema(spec: ToolSpec<never>): Record<string, unknown> {
  const properties: Record<string, unknown> = { ...spec.properties };
  for (const name of spec.nullable) {
    const schema: Record<string, unknown> = { ...(spec.properties[name] as PropertySchema) };
    schema.type = [schema.type ?? "string", "null"];
    if ("enum" in schema) schema.enum = [...(schema.enum as unknown[]), null];
    properties[name] = schema;
  }
  return {
    type: "object",
    properties,
    required: [...spec.required, ...spec.nullable.filter((n) => !spec.required.includes(n))],
    additionalProperties: false,
  };
}

/** Every tool by name, in provider order; a duplicate name is a bug. */
export function allTools<Store>(
  providers: readonly (readonly ToolSpec<Store>[])[],
): Map<string, ToolSpec<Store>> {
  const out = new Map<string, ToolSpec<Store>>();
  for (const specs of providers) {
    for (const spec of specs) {
      if (out.has(spec.name)) throw new Error(`duplicate MCP tool ${spec.name}`);
      out.set(spec.name, spec);
    }
  }
  return out;
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `isinstance(value, _TYPES[kind])` on decoded JSON (unknown kinds accept anything). */
function hasType(value: unknown, kind: string): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "integer":
      return (typeof value === "number" && Number.isInteger(value)) || typeof value === "bigint";
    case "number":
      return typeof value === "number" || typeof value === "bigint";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

/** Python `str()` of a schema value in a message. */
function show(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : floatRepr(value);
  return String(value);
}

/** Python `==` membership of a decoded JSON scalar in an enum list. */
function inEnum(value: unknown, options: readonly unknown[]): boolean {
  return options.some((o) => o === value);
}

function numberValue(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : (value as number);
}

/**
 * Check the arguments against the spec (names, types, enums, lengths); defaults filled in. Messages
 * name the argument, never echo its value.
 */
export function validateArguments(
  spec: ToolSpec<never>,
  args: ToolArgs | null | undefined,
): Record<string, unknown> {
  const given: ToolArgs = args ?? {};
  const has = (name: string) => Object.hasOwn(given, name);
  const names = Object.keys(given);
  const refused = names.filter((n) => Object.hasOwn(spec.refused, n)).sort(compareCodePoints);
  if (refused.length > 0)
    throw new ToolError(spec.refused[refused[0] as string] as string, "invalid_arguments");
  const declared = Object.keys(spec.properties);
  const unknown = names.filter((n) => !Object.hasOwn(spec.properties, n));
  if (unknown.length > 0) {
    throw new ToolError(
      `unknown argument(s): ${unknown.length}; allowed: ${declared.join(", ") || "none"}`,
      "invalid_arguments",
    );
  }
  for (const name of spec.required) {
    if ((given[name] ?? null) === null && !spec.nullable.includes(name)) {
      throw new ToolError(`missing argument: ${name}`, "invalid_arguments");
    }
  }
  for (const name of spec.nullable) {
    if (!has(name))
      throw new ToolError(`missing argument: ${name} (null clears it)`, "invalid_arguments");
  }
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(spec.properties)) {
    if (spec.nullable.includes(name) && has(name) && given[name] === null) {
      out[name] = null;
      continue;
    }
    if (!has(name) || given[name] === null || given[name] === undefined) {
      if ("default" in schema) out[name] = schema.default;
      continue;
    }
    const value = given[name];
    const kind = schema.type ?? "string";
    if (typeof value === "boolean" && (kind === "integer" || kind === "number")) {
      throw new ToolError(`argument ${name} must be a ${kind}`, "invalid_arguments");
    }
    if (!hasType(value, kind))
      throw new ToolError(`argument ${name} must be a ${kind}`, "invalid_arguments");
    const refusedValues = spec.refusedValues[name] ?? {};
    if (typeof value === "string" && Object.hasOwn(refusedValues, value)) {
      throw new ToolError(refusedValues[value] as string, "invalid_arguments");
    }
    if (schema.enum !== undefined && !inEnum(value, schema.enum)) {
      throw new ToolError(
        `argument ${name} must be one of: ${schema.enum.map(show).join(", ")}`,
        "invalid_arguments",
      );
    }
    if (typeof value === "string") {
      const limit = schema.maxLength ?? MAX_STRING;
      if (pyLen(value) > limit)
        throw new ToolError(`argument ${name} is too long (max ${limit})`, "invalid_arguments");
    }
    if (kind === "integer") {
      const lo = schema.minimum;
      const hi = schema.maximum;
      const n = numberValue(value);
      if ((lo !== undefined && n < lo) || (hi !== undefined && n > hi)) {
        throw new ToolError(
          `argument ${name} must be in [${show(lo)}, ${show(hi)}]`,
          "invalid_arguments",
        );
      }
    }
    out[name] = value;
  }
  return out;
}
