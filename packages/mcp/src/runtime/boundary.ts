/** Native boundary contracts and result helpers, independent of server orchestration. */
import type { Outcome } from "../privacy/audit.js";
import type { JsonValue } from "../privacy/pyJson.js";
import { LeakDetected, leakCheck, type Privacy, UnlabelledValue } from "../privacy/redactor.js";
import { scrubText } from "../privacy/scrub.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import type { NativePreparationExecution, NativePreparationRuntime } from "./async.js";
import type { NativePolicy } from "./policy.js";
import type { NativeToolStore } from "./types.js";
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

export interface NativeExecution {
  readonly context: ToolContext<NativeToolStore>;
  readonly policy: NativePolicy;
  /** True only after a durable write has a completed receipt. */
  hasWritten?(): boolean;
  writeKey?(): string | undefined;
  uncertainWriteKey?(): string | undefined;
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
  readonly preparations?: NativePreparationRuntime;
  readonly audit: AuditPort;
  readonly now: () => number;
  readonly replaced: () => boolean;
  /** Executes with freshly read policy. Native writes own the vault queue separately. */
  execute<T>(
    ceiling: Privacy | undefined,
    fn: (execution: NativeExecution | undefined) => T | Promise<T>,
    requestKey?: string,
  ): Promise<T>;
  policy(): Promise<NativePolicy | undefined>;
  /** Metadata-only status for an original durable write key in this authenticated vault. */
  writeStatus?(
    key: string,
  ): Promise<
    | { readonly kind: "outcome_unknown" }
    | { readonly kind: "completed" }
    | { readonly kind: "refused" | "not_started"; readonly reason: string }
  >;
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
  /** Opaque original key for reconciliation after an ambiguous durable write. */
  readonly requestKey?: string;
}
export const failure = (
  error: string,
  errorKind: string,
  privacy: Privacy = "strict",
): NativeCallResult => ({ ok: false, error, errorKind, privacy });
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

/** Diagnostics must never change an already committed result or create an unhandled rejection. */
export function warnNative(runtime: Pick<NativeRuntime, "warn">, code: string): void {
  try {
    runtime.warn(code);
  } catch {
    /* diagnostics are best effort */
  }
}

/** Shared fresh-context error rendering for synchronous and reentered async calls. */
export function renderNativeError(
  context: Pick<NativePreparationExecution["context"], "guard">,
  privacy: Privacy,
  error: unknown,
): NativeCallResult | undefined {
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
    return {
      ...failure(message, error.kind, privacy),
      ...(error.requestKey ? { requestKey: error.requestKey } : {}),
    };
  }
  if (error instanceof LeakDetected || error instanceof UnlabelledValue)
    return failure(
      "the answer was withheld by the privacy check (nothing was sent or saved)",
      error instanceof LeakDetected ? "privacy_check" : "unlabelled",
      privacy,
    );

  return undefined;
}

export interface NativeCallBoundary {
  readonly runtime: NativeRuntime;
  audited(
    name: string,
    arguments_: ToolArgs | null,
    known: ReadonlySet<string>,
    action: () => Promise<NativeCallResult>,
    finalize?: (result: NativeCallResult) => Promise<NativeCallResult>,
  ): Promise<NativeCallResult>;
}
