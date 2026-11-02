/** Native S38b read bodies. No labelled oracle tree contributes to these five answers. */
import {
  budgetTools,
  decodeEntityRef,
  type EntityRefKind,
  enabledIn,
  investmentTools,
  type JsonValue,
  LeakDetected,
  leakCheck,
  loansTools,
  type NativeToolStore,
  Redactor,
  scrubText,
  type ToolContext,
  ToolError,
  UnlabelledValue,
  validateArguments,
} from "@cashu/mcp";
import type { CanonObject, CanonValue } from "../../json.ts";
import { type OutValue, PyFloat } from "../output.ts";

const NATIVE_READS = [
  "spending_breakdown",
  "cashflow_summary",
  "recurring_payments",
  "uncategorized_merchants",
  "loans_summary",
  "portfolio_overview",
  "positions",
  "signals",
  "review_context",
  "strategy_status",
  "history_metrics",
  "theses",
] as const;
interface NativeCall {
  readonly name: string;
  readonly call: string;
  readonly args: Record<string, unknown>;
}
const NATIVE_CALLS = NATIVE_READS.flatMap<NativeCall>((name) =>
  name === "signals"
    ? ["open", "history", "all"].map((status) => ({
        name,
        call: `signals(status=${status})`,
        args: { status },
      }))
    : [{ name, call: `${name}()`, args: {} }],
);
const NATIVE_NAMES: ReadonlySet<string> = new Set(NATIVE_READS);
const specs = new Map(
  [...budgetTools(), ...loansTools(), ...investmentTools()].map((spec) => [spec.name, spec]),
);
export interface InvestmentReferences {
  ref(kind: EntityRefKind, gid: string): string;
  rule(value: string): string;
}

/** Called only after real redaction and leak checking. Canonicalize this one typed reference field. */
function canonicalNative(
  value: JsonValue,
  loanKey: (gid: string) => string,
  investments: InvestmentReferences | undefined,
  field?: string,
): OutValue {
  if (field === "loan_id") {
    if (typeof value !== "string") throw new Error("native loan reference is not a string");
    return loanKey(decodeEntityRef("loan", value));
  }
  if (value !== null && investments !== undefined) {
    const kinds: Readonly<Record<string, EntityRefKind>> = {
      instrument_id: "instrument",
      signal_id: "signal",
      thesis_id: "thesis",
      alert_id: "alert",
    };
    const kind = field === undefined ? undefined : kinds[field];
    if (kind !== undefined) {
      if (typeof value !== "string") throw new Error("native investment reference is not a string");
      return investments.ref(kind, decodeEntityRef(kind, value));
    }
    if (field === "rule" && typeof value === "string" && value.startsWith("alert:"))
      return investments.rule(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "number") return new PyFloat(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map((entry) => canonicalNative(entry, loanKey, investments));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      canonicalNative(entry, loanKey, investments, key),
    ]),
  );
}

/** Mirrors the Python oracle's no-audit call boundary, using actual native handlers and providers. */
export function nativeMcpReads(
  context: ToolContext<NativeToolStore>,
  modules: ReadonlySet<string>,
  loanKey: (gid: string) => string,
  investments?: InvestmentReferences,
): Readonly<Record<string, OutValue>> {
  return Object.fromEntries(
    NATIVE_CALLS.map(({ name, call, args }) => {
      const spec = specs.get(name);
      if (spec === undefined || spec.write) throw new Error("native read manifest is incomplete");
      if (!enabledIn(spec, modules)) return [call, { error_kind: "module_disabled" }];
      try {
        const tree = spec.handler(context, validateArguments(spec, args));
        const redactor = new Redactor({ privacy: context.privacy, guard: context.guard });
        const data = redactor.apply(tree);
        if (data === null || typeof data !== "object" || Array.isArray(data))
          throw new UnlabelledValue("a tool must return an object");
        leakCheck(data, {
          strict: redactor.strict,
          isins: redactor.isins,
          nonMoney: redactor.nonMoney,
        });
        return [call, canonicalNative(data, loanKey, investments)];
      } catch (error) {
        if (error instanceof ToolError) {
          let message = scrubText(error.message, { strict: !error.system, guard: context.guard });
          try {
            leakCheck({ error: message }, { strict: true });
          } catch (failure) {
            if (!(failure instanceof LeakDetected)) throw failure;
            message = "the error text was withheld by the privacy check";
          }
          return [call, { error_kind: error.kind, error: message }];
        }
        if (error instanceof UnlabelledValue) return [call, { error_kind: "unlabelled" }];
        if (error instanceof LeakDetected) return [call, { error_kind: "privacy_check" }];
        throw error;
      }
    }),
  );
}

/** Unknown/new variants of native calls cannot silently fall back to the labelled Python replay. */
export function mergeMcpReads(
  calls: CanonObject,
  native: Readonly<Record<string, OutValue>>,
  replay: (entry: CanonValue) => OutValue,
): Record<string, OutValue> {
  for (const { call } of NATIVE_CALLS) {
    if (!calls.has(call) || !Object.hasOwn(native, call))
      throw new Error("native MCP read coverage is incomplete");
  }
  return Object.fromEntries(
    [...calls].map(([call, entry]) => {
      if (Object.hasOwn(native, call)) return [call, native[call] as OutValue];
      if (NATIVE_NAMES.has(call.split("(")[0] ?? ""))
        throw new Error("native MCP read arguments are not covered");
      return [call, replay(entry)];
    }),
  );
}
