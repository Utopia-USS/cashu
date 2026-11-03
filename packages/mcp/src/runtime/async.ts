/** Owned, bounded async phases. No read capability or execution crosses a phase boundary. */
import type { LabelledTree } from "../privacy/labels.js";
import type { NameSources } from "../privacy/names.js";
import type { Privacy } from "../privacy/redactor.js";
import type { ToolArgs, ToolContext } from "../registry.js";
import type { NativeAsyncIo } from "./io.js";
import type { NativePolicy } from "./policy.js";

export type { NativeAsyncIo } from "./io.js";

import type { NativeToolStore } from "./types.js";

export type NativePreparationStore = Omit<NativeToolStore, "run">;
export interface NativePreparationExecution {
  readonly context: ToolContext<NativePreparationStore>;
  readonly policy: NativePolicy;
}
export interface NativePreparationRuntime {
  execute<T>(
    ceiling: Privacy | undefined,
    fn: (execution: NativePreparationExecution | undefined) => T,
  ): Promise<T>;
}
/** Only plain owned data. Bytes are privately copied, never frozen or shared with a provider. */
export type NativeAsyncValue =
  | null
  | string
  | number
  | boolean
  | bigint
  | Uint8Array
  | readonly NativeAsyncValue[]
  | { readonly [key: string]: NativeAsyncValue };
export type NativeAsyncStep =
  | { readonly kind: "io"; readonly operation: NativeAsyncValue; readonly io: NativeAsyncIo }
  | { readonly kind: "ready"; readonly ready: NativeAsyncValue };
interface NativeAsyncFinish {
  readonly answer: LabelledTree;
  /** A composition from actual winning prospective facts, never retained after redaction. */
  readonly prospectiveNames?: {
    readonly profileId: number | bigint;
    readonly providers: readonly NameSources[];
  };
  readonly cacheFailureAnswer?: LabelledTree;
  readonly afterCommit?: { readonly data: NativeAsyncValue; readonly io: NativeAsyncIo };
}
export interface NativeAsyncAdapter {
  readonly name: "search_instruments" | "add_to_watchlist" | "propose_import";
  readonly maxIoPhases: number;
  current(context: ToolContext<NativePreparationStore>, io: NativeAsyncIo): boolean;
  advance(
    context: ToolContext<NativePreparationStore>,
    args: Readonly<ToolArgs>,
    resume: NativeAsyncValue | undefined,
  ): NativeAsyncStep;
  perform(
    operation: NativeAsyncValue,
    io: NativeAsyncIo,
    signal: AbortSignal,
    warn: (code: "mcp.import-stage-cleanup-failed") => void,
  ): Promise<NativeAsyncValue>;
  finish(
    context: ToolContext<NativeToolStore>,
    args: Readonly<ToolArgs>,
    ready: NativeAsyncValue,
  ): NativeAsyncFinish | Promise<NativeAsyncFinish>;
  /** Bounded synchronous cache publication, outside the vault queue. */
  afterCommit?(data: NativeAsyncValue, io: NativeAsyncIo): void;
}

/** Reject getters/classes/cycles instead of retaining caller-owned objects across audit/I/O. */
export function ownedValue(input: unknown, depth = 0): NativeAsyncValue {
  if (depth > 64) throw new Error("async value nesting limit");
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean" ||
    typeof input === "bigint" ||
    (typeof input === "number" && Number.isFinite(input))
  )
    return input;
  if (input instanceof Uint8Array) return Uint8Array.from(input);
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype)
      throw new Error("invalid async array prototype");
    const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      Reflect.ownKeys(input).length !== length + 1
    )
      throw new Error("invalid async array shape");
    const result: NativeAsyncValue[] = [];
    for (let index = 0; index < length; index++) {
      const property = Object.getOwnPropertyDescriptor(input, String(index));
      if (!property || !Object.hasOwn(property, "value"))
        throw new Error("async array accessor or hole");
      result.push(ownedValue(property.value, depth + 1));
    }
    return Object.freeze(result);
  }
  if (typeof input !== "object" || input === null) throw new Error("invalid async value");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("invalid async value prototype");
  const result: Record<string, NativeAsyncValue> = Object.create(null);
  for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!Object.hasOwn(property, "value")) throw new Error("async value accessor");
    result[key] = ownedValue(property.value, depth + 1);
  }
  return Object.freeze(result);
}
