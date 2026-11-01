// Native MCP call boundary: reread policy, audit first, redact before committing buffered writes.

import { type Outcome, summarizeArgs } from "../privacy/audit.js";
import { type JsonValue, pyDumps } from "../privacy/pyJson.js";
import {
  LeakDetected,
  leakCheck,
  type Privacy,
  Redactor,
  UnlabelledValue,
} from "../privacy/redactor.js";
import { scrubText } from "../privacy/scrub.js";
import {
  enabledIn,
  inputSchema,
  type ToolArgs,
  type ToolContext,
  ToolError,
  type ToolSpec,
  validateArguments,
} from "../registry.js";
import type { NativeToolStore } from "./types.js";

export const INSTRUCTIONS =
  "cashU: local personal finance data of ONE profile. Every answer passes a privacy layer: in 'strict' mode you get shares and percentages, never absolute amounts; identifiers (account numbers, IBANs, person names) are never sent in any mode. Call profile_overview first: it says which modules are enabled and the privacy level. Write tools only create records or proposals; the owner approves proposals in the app. Do not ask the user for raw exports or database files.";
export const APP_UPDATED =
  "cashU was updated while this MCP server was running, so this server stops now and nothing was run. Reconnect it (Claude Code: /mcp) to use the new version, then repeat the call.";
export const CEILING_KEY = "cashu/privacyCeiling";
export const EFFECTIVE_PRIVACY_KEY = "cashu/effectivePrivacy";
export const BRIDGE_CAPABILITY = "cashu/hostPolicyV1";
export const NAME_GUARD_KEY = "cashu/nameGuard";
export const NAME_GUARD_APPLIED_KEY = "cashu/nameGuardApplied";
/** Restrictive raw sources only: no replacement targets, symbols, secrets or profile identifiers. */
export interface DelegatedNameSources {
  readonly persons: readonly string[];
  readonly strongNames: readonly string[];
  readonly privatePayees: readonly string[];
  readonly strictNames: readonly string[];
}

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
export interface NativePolicy {
  readonly privacy: Privacy;
  readonly modules: ReadonlySet<string>;
}
export interface NativeExecution {
  readonly context: ToolContext<NativeToolStore>;
  readonly policy: NativePolicy;
  commit(): void;
}
export interface AuditPort {
  start(tool: string, args: Readonly<Record<string, string | number>>): Promise<number>;
  finish(
    id: number,
    privacy: Privacy,
    outcome: Exclude<Outcome, "started">,
    errorKind: string | null,
    duration: number,
  ): Promise<void>;
}
export interface NativeRuntime {
  readonly audit: AuditPort;
  readonly now: () => number;
  readonly replaced: () => boolean;
  /** Executes synchronously under this vault's write queue, with freshly read policy. */
  execute<T>(
    ceiling: Privacy | undefined,
    fn: (execution: NativeExecution | undefined) => T,
  ): Promise<T>;
  policy(): Promise<NativePolicy | undefined>;
  /** Captures current policy and restrictive name sources in the same vault queue step. */
  delegation(): Promise<(NativePolicy & { readonly names: DelegatedNameSources }) | undefined>;
  warn(code: string): void;
}
export interface NativeCallResult {
  readonly ok: boolean;
  readonly privacy: Privacy;
  readonly data?: JsonValue;
  readonly error?: string;
  readonly errorKind?: string;
}
export const failure = (
  error: string,
  errorKind: string,
  privacy: Privacy = "strict",
): NativeCallResult => ({ ok: false, error, errorKind, privacy });
const REFUSED = new Set([
  "privacy_check",
  "unlabelled",
  "module_disabled",
  "profile_missing",
  "bridge_unavailable",
  "invalid_policy",
]);

/** Undefined means no ceiling; an explicitly invalid value is refused, never ignored. */
export function privacyCeiling(meta: unknown): Privacy | undefined {
  if (meta === undefined || meta === null) return undefined;
  if (typeof meta !== "object" || Array.isArray(meta))
    throw new ToolError("invalid private policy metadata", "invalid_policy", { system: true });
  if (!Object.hasOwn(meta, CEILING_KEY)) return undefined;
  const value = (meta as Record<string, unknown>)[CEILING_KEY];
  if (value !== "strict" && value !== "amounts")
    throw new ToolError("invalid private policy metadata", "invalid_policy", { system: true });
  return value;
}
export const restrictivePrivacy = (a: Privacy, b?: Privacy): Privacy =>
  a === "strict" || b === "strict" ? "strict" : "amounts";

export class NativeMcpServer {
  readonly tools: ReadonlyMap<string, ToolSpec<NativeToolStore>>;
  readonly runtime: NativeRuntime;
  constructor(runtime: NativeRuntime, tools: readonly ToolSpec<NativeToolStore>[]) {
    this.runtime = runtime;
    this.tools = new Map(tools.map((spec) => [spec.name, spec]));
    if (this.tools.size !== tools.length) throw new Error("duplicate native tool");
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
      this.runtime.warn("mcp.internal");
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
      this.runtime.warn("mcp.audit-finish-failed");
    }
    return result;
  }
  async call(
    name: string,
    arguments_: ToolArgs | null = null,
    ceiling?: Privacy,
  ): Promise<NativeCallResult> {
    const spec = this.tools.get(name);
    return this.audited(
      spec?.name ?? "(unknown)",
      arguments_,
      new Set(Object.keys(spec?.properties ?? {})),
      async () =>
        this.runtime.execute(ceiling, (execution) => {
          if (this.runtime.replaced()) return failure(APP_UPDATED, "app_updated");
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
            const args = validateArguments(spec, arguments_);
            const tree = spec.handler(context, args);
            const redactor = new Redactor({ privacy, guard: context.guard });
            const data = redactor.apply(tree);
            if (data === null || typeof data !== "object" || Array.isArray(data))
              throw new UnlabelledValue("a tool must return an object");
            leakCheck(data, {
              strict: redactor.strict,
              isins: redactor.isins,
              nonMoney: redactor.nonMoney,
            });
            execution.commit();
            return { ok: true, privacy, data };
          } catch (error) {
            if (error instanceof ToolError) {
              let guard = null;
              try {
                guard = context.guard;
              } catch {
                /* A failed guard must never expose the exception. */
              }
              let message = scrubText(error.message, { strict: !error.system, guard });
              try {
                leakCheck({ error: message }, { strict: true });
              } catch {
                message = "the error text was withheld by the privacy check";
              }
              return failure(message, error.kind, privacy);
            }
            if (error instanceof LeakDetected || error instanceof UnlabelledValue)
              return failure(
                "the answer was withheld by the privacy check (nothing was sent or saved)",
                error instanceof LeakDetected ? "privacy_check" : "unlabelled",
                privacy,
              );
            throw error;
          }
        }),
    );
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
