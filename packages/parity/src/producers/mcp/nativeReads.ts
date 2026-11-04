/** Native S38b read bodies. No labelled oracle tree contributes to these five answers. */

import { summaryOk } from "@cashu/domain/investments/macro";
import {
  budgetTools,
  connectorTools,
  coreTools,
  decodeEntityRef,
  type EntityRefKind,
  enabledIn,
  investmentSearchAdapter,
  investmentTools,
  investmentWriteTools,
  type JsonValue,
  LeakDetected,
  leakCheck,
  loansTools,
  type NativeToolStore,
  Redactor,
  researchTools,
  scrubText,
  type ToolContext,
  ToolError,
  UnlabelledValue,
  validateArguments,
} from "@cashu/mcp";
import type { CanonObject } from "../../json.ts";
import { type OutValue, PyFloat } from "../output.ts";

const NATIVE_READS = [
  "profile_overview",
  "setup_status",
  "networth_breakdown",
  "search_instruments",
  "connectors",
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
  "research_context",
  "research_notes",
  "alerts",
  "watchlist",
] as const;
interface NativeCall {
  readonly name: string;
  readonly call: string;
  readonly args: Record<string, unknown>;
}
const NATIVE_CALLS = NATIVE_READS.flatMap<NativeCall>((name) =>
  name === "setup_status"
    ? ["budget", "assets", "loans", "investments"].map((module) => ({
        name,
        call: `setup_status(module=${module})`,
        args: { module },
      }))
    : name === "search_instruments"
      ? [{ name, call: "search_instruments(query=ETF)", args: { query: "ETF" } }]
      : name === "signals"
        ? ["open", "history", "all"].map((status) => ({
            name,
            call: `signals(status=${status})`,
            args: { status },
          }))
        : name === "alerts"
          ? [
              { name, call: "alerts()", args: {} },
              { name, call: "alerts(status=all)", args: { status: "all" } },
            ]
          : [{ name, call: `${name}()`, args: {} }],
);
const NATIVE_NAMES: ReadonlySet<string> = new Set(NATIVE_READS);
const specs = new Map(
  [
    ...coreTools(),
    ...connectorTools(),
    ...budgetTools(),
    ...loansTools(),
    ...investmentTools(),
    ...investmentWriteTools(),
    ...researchTools(),
  ].map((spec) => [spec.name, spec]),
);
export interface InvestmentReferences {
  ref(kind: EntityRefKind, gid: string): string;
  rule(value: string): string;
  searchKey(value: string): string;
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
    if (field === "key" && typeof value === "string" && value.startsWith("i:"))
      return investments.searchKey(value);
    const kinds: Readonly<Record<string, EntityRefKind>> = {
      instrument_id: "instrument",
      signal_id: "signal",
      thesis_id: "thesis",
      alert_id: "alert",
      run_id: "run",
      running_run_id: "run",
      note_id: "note",
      item_id: "watchlist",
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
export async function nativeMcpReads(
  context: ToolContext<NativeToolStore>,
  modules: ReadonlySet<string>,
  loanKey: (gid: string) => string,
  investments?: InvestmentReferences,
): Promise<Readonly<Record<string, OutValue>>> {
  const readOne = async ({
    name,
    call,
    args,
  }: NativeCall): Promise<readonly [string, OutValue]> => {
    const spec = specs.get(name);
    if (spec === undefined || spec.write) throw new Error("native read manifest is incomplete");
    if (!enabledIn(spec, modules)) return [call, { error_kind: "module_disabled" }];
    try {
      const validated = validateArguments(spec, args);
      const answer =
        name === "search_instruments"
          ? await (async () => {
              const step = investmentSearchAdapter.advance(context, validated, undefined);
              if (step.kind !== "ready") throw new Error("offline MCP parity attempted search I/O");
              return (await investmentSearchAdapter.finish(context, validated, step.ready)).answer;
            })()
          : await spec.handler(context, validated);
      const redactor = new Redactor({
        privacy: context.privacy,
        guard: context.guard,
        summaryOk,
      });
      const data = redactor.apply(answer);
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
  };
  const rows: Array<readonly [string, OutValue]> = [];
  for (const entry of NATIVE_CALLS) rows.push(await readOne(entry));
  return Object.fromEntries(rows);
}

/** Unknown/new variants of native calls cannot silently fall back to the labelled Python replay. */
export function mergeMcpReads(
  calls: CanonObject,
  native: Readonly<Record<string, OutValue>>,
): Record<string, OutValue> {
  for (const { call } of NATIVE_CALLS) {
    if (!calls.has(call) || !Object.hasOwn(native, call))
      throw new Error("native MCP read coverage is incomplete");
  }
  return Object.fromEntries(
    [...calls].map(([call]) => {
      if (Object.hasOwn(native, call)) return [call, native[call] as OutValue];
      if (NATIVE_NAMES.has(call.split("(")[0] ?? ""))
        throw new Error("native MCP read arguments are not covered");
      throw new Error("native MCP read coverage is incomplete");
    }),
  );
}
