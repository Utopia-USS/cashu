// Native MCP call boundary: reread policy, audit first, redact before committing buffered writes.
import { summaryOk } from "@cashu/domain/investments/macro";

import { summarizeArgs } from "../privacy/audit.js";
import { type JsonValue, pyDumps } from "../privacy/pyJson.js";
import { leakCheck, type Privacy, Redactor, UnlabelledValue } from "../privacy/redactor.js";
import {
  enabledIn,
  inputSchema,
  type ToolArgs,
  type ToolSpec,
  validateArguments,
} from "../registry.js";
import type { NativeAsyncAdapter } from "./async.js";
import { NativeAsyncLifecycle, runNativeAsyncCall } from "./asyncCall.js";
import {
  APP_UPDATED,
  failure,
  type NativeCallResult,
  type NativeRuntime,
  renderNativeError,
  restrictivePrivacy,
  warnNative,
} from "./boundary.js";
import { finalizeNativeDelivery, guardInputFingerprint } from "./delivery.js";
import type { NativeToolStore } from "./types.js";

export {
  APP_UPDATED,
  type AuditPort,
  BRIDGE_CAPABILITY,
  CEILING_KEY,
  type DelegatedNameSources,
  EFFECTIVE_PRIVACY_KEY,
  failure,
  NAME_GUARD_APPLIED_KEY,
  NAME_GUARD_KEY,
  type NativeCallResult,
  type NativeExecution,
  type NativeRuntime,
  privacyCeiling,
  restrictivePrivacy,
} from "./boundary.js";
export type { NativePolicy } from "./policy.js";

export const INSTRUCTIONS =
  "cashU: local personal finance data of ONE profile. Every answer passes a privacy layer: in 'strict' mode you get shares and percentages, never absolute amounts; identifiers (account numbers, IBANs, person names) are never sent in any mode. Call profile_overview first: it says which modules are enabled and the privacy level. Write tools only create records or proposals; the owner approves proposals in the app. Do not ask the user for raw exports or database files.";
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: false;
    readonly openWorldHint: false;
  };
}
export function toolDescriptor(
  spec: Pick<
    ToolSpec<never>,
    "name" | "description" | "properties" | "required" | "nullable" | "write"
  >,
): ToolDescriptor {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: inputSchema(spec),
    annotations: { readOnlyHint: !spec.write, destructiveHint: false, openWorldHint: false },
  };
}
const REFUSED = new Set([
  "privacy_check",
  "unlabelled",
  "module_disabled",
  "profile_missing",
  "bridge_unavailable",
  "invalid_policy",
]);

export class NativeMcpServer {
  readonly tools: ReadonlyMap<string, ToolSpec<NativeToolStore>>;
  readonly runtime: NativeRuntime;
  private readonly asyncTools: ReadonlyMap<string, NativeAsyncAdapter>;
  private readonly lifecycle = new NativeAsyncLifecycle();
  constructor(
    runtime: NativeRuntime,
    tools: readonly ToolSpec<NativeToolStore>[],
    adapters: readonly NativeAsyncAdapter[] = [],
  ) {
    this.runtime = runtime;
    this.asyncTools = new Map(adapters.map((adapter) => [adapter.name, adapter]));
    if (this.asyncTools.size !== adapters.length) throw new Error("duplicate async tool");
    for (const adapter of adapters) {
      if (
        !tools.some((tool) => tool.name === adapter.name) ||
        !Number.isSafeInteger(adapter.maxIoPhases) ||
        adapter.maxIoPhases < 1 ||
        adapter.maxIoPhases > 2
      )
        throw new Error("invalid async native registration");
    }
    this.tools = new Map(tools.map((spec) => [spec.name, spec]));
    if (this.tools.size !== tools.length) throw new Error("duplicate native tool");
  }
  invalidateAsync(): void {
    this.lifecycle.invalidate();
  }
  async list(): Promise<ToolDescriptor[]> {
    if (this.runtime.replaced()) return [];
    const policy = await this.runtime.policy();
    return policy === undefined
      ? []
      : [...this.tools.values()]
          .filter((spec) => enabledIn(spec, policy.modules))
          .map(toolDescriptor);
  }
  async audited(
    name: string,
    arguments_: ToolArgs | null,
    known: ReadonlySet<string>,
    action: () => Promise<NativeCallResult>,
    finalize?: (result: NativeCallResult) => Promise<NativeCallResult>,
  ): Promise<NativeCallResult> {
    if (this.runtime.replaced()) return failure(APP_UPDATED, "app_updated");
    const started = this.runtime.now();
    let id: number;
    try {
      id = await this.runtime.audit.start(name, summarizeArgs(arguments_, known));
    } catch {
      return this.runtime.replaced()
        ? failure(APP_UPDATED, "app_updated")
        : failure(
            "the call was not run: the audit log cannot be written (is the app's database available?)",
            "audit_unavailable",
          );
    }
    let result: NativeCallResult;
    try {
      result = this.runtime.replaced() ? failure(APP_UPDATED, "app_updated") : await action();
    } catch {
      warnNative(this.runtime, "mcp.internal");
      result = failure("internal error (details are in the app's log)", "internal");
    }
    try {
      await this.runtime.audit.finish(
        id,
        result.privacy,
        result.ok ? "ok" : REFUSED.has(result.errorKind ?? "") ? "refused" : "error",
        result.errorKind ?? null,
        Math.max(0, Math.trunc(this.runtime.now() - started)),
      );
    } catch {
      warnNative(this.runtime, "mcp.audit-finish-failed");
    }
    return finalize ? finalize(result) : result;
  }
  async call(
    name: string,
    arguments_: ToolArgs | null = null,
    ceiling?: Privacy,
    requestKey?: string,
  ): Promise<NativeCallResult> {
    const spec = this.tools.get(name);
    const adapter = this.asyncTools.get(name);
    if (spec && adapter)
      return runNativeAsyncCall(
        this,
        this.lifecycle,
        spec,
        adapter,
        arguments_,
        ceiling,
        requestKey,
      );
    const call = this.lifecycle.begin();
    let completed = false;
    let guardInputs: string | undefined;
    try {
      return await this.audited(
        spec?.name ?? "(unknown)",
        arguments_,
        new Set(Object.keys(spec?.properties ?? {})),
        async () =>
          this.runtime.execute(
            ceiling,
            async (execution) => {
              if (this.runtime.replaced()) return failure(APP_UPDATED, "app_updated");
              if (call.stopped())
                return failure("the MCP session is no longer active", "session_closed");
              if (execution === undefined)
                return failure("the profile of this server no longer exists", "profile_missing");
              const { context, policy } = execution;
              const privacy = restrictivePrivacy(policy.privacy, ceiling);
              if (spec === undefined) return failure("unknown tool", "unknown_tool", privacy);
              if (!enabledIn(spec, policy.modules))
                return failure(
                  `tool ${spec.name} belongs to the module '${spec.module}', which is not enabled for this profile`,
                  "module_disabled",
                  privacy,
                );
              try {
                guardInputs = guardInputFingerprint(context.guard);
                const args = validateArguments(spec, arguments_);
                const tree = await spec.handler(context, args);
                const redactor = new Redactor({ privacy, guard: context.guard, summaryOk });
                const data = redactor.apply(tree);
                if (data === null || typeof data !== "object" || Array.isArray(data))
                  throw new UnlabelledValue("a tool must return an object");
                leakCheck(data, {
                  strict: redactor.strict,
                  isins: redactor.isins,
                  nonMoney: redactor.nonMoney,
                });
                execution.commit();
                completed = true;
                return {
                  ok: true,
                  privacy,
                  data,
                  ...(execution.hasWritten?.() ? { requestKey: execution.writeKey?.() } : {}),
                };
              } catch (error) {
                if (execution.hasWritten?.()) {
                  completed = true;
                  return {
                    ...failure("write completed; response withheld", "response_withheld", privacy),
                    requestKey: execution.writeKey?.(),
                  };
                }
                const uncertainKey = execution.uncertainWriteKey?.();
                if (uncertainKey !== undefined)
                  return {
                    ...failure(
                      "write outcome unknown; inspect the original key",
                      "outcome_unknown",
                      "strict",
                    ),
                    requestKey: uncertainKey,
                  };
                const rendered = renderNativeError(context, privacy, error);
                if (rendered) return rendered;
                throw error;
              }
            },
            requestKey,
          ),
        (result) =>
          finalizeNativeDelivery(
            this.runtime,
            spec,
            result,
            { completed, guardInputs, requireGuard: completed },
            call.stopped,
            ceiling,
          ),
      );
    } finally {
      call.finish();
    }
  }
}

/** Python json.dumps(indent=1), preserving bigint integers and float representation. */
export function resultText(value: JsonValue, depth = 0): string {
  if (value === null || typeof value !== "object") return pyDumps(value);
  const entries: readonly [string | null, JsonValue][] = Array.isArray(value)
    ? value.map((v) => [null, v] as const)
    : Object.entries(value).map(([k, v]) => [k, v] as const);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return `${open}${close}`;
  return `${open}\n${entries.map(([key, v]) => `${" ".repeat(depth + 1)}${key === null ? "" : `${pyDumps(key)}: `}${resultText(v, depth + 1)}`).join(",\n")}\n${" ".repeat(depth)}${close}`;
}
