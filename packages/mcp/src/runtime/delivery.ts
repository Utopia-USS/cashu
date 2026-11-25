/** Last bounded delivery decision, after the audit await. No handler/labels/write is replayed. */
import { pyLen, sha256Hex } from "@cashu/domain";
import type { NameGuard } from "../privacy/names.js";
import type { Privacy } from "../privacy/redactor.js";
import { enabledIn, type ToolSpec } from "../registry.js";
import type { NativePreparationExecution } from "./async.js";
import {
  failure,
  type NativeCallResult,
  type NativeRuntime,
  restrictivePrivacy,
  warnNative,
} from "./boundary.js";

/** Memory-only fingerprint. Never loads, contains, logs or persists secret bytes. */
export function guardInputFingerprint(guard: NameGuard): string {
  // swapAliases applies this effective sequence. Equal-length order and duplicates can matter.
  const aliases = guard.strictAliases
    .map(([alias, replacement], index) => ({ alias, replacement, index }))
    .sort((a, b) => pyLen(b.alias) - pyLen(a.alias) || a.index - b.index)
    .map(({ alias, replacement }) => [alias, replacement]);
  // publicName instead uses original strip/casefold first-match order; padded aliases can collide.
  const publicAliases = guard.strictAliases.map(([alias, replacement]) => [alias, replacement]);
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        profile: String(guard.profileId),
        names: [...guard.names].sort(),
        payees: [...guard.privatePayees].sort(),
        symbols: [...guard.symbols].sort(),
        aliases,
        publicAliases,
      }),
    ),
  );
}
export interface NativeDeliveryProof {
  /** The native commit boundary completed; a read/blocked preview may have emitted no events. */
  readonly completed: boolean;
  readonly guardInputs?: string;
  readonly requireGuard?: boolean;
  readonly fixedRefusal?: boolean;
}
export async function finalizeNativeDelivery(
  runtime: NativeRuntime,
  spec: Pick<ToolSpec<never>, "module" | "also"> | undefined,
  result: NativeCallResult,
  proof: NativeDeliveryProof,
  stopped: () => boolean,
  ceiling?: Privacy,
  current?: (execution: NativePreparationExecution) => boolean,
): Promise<NativeCallResult> {
  const withheld = (): NativeCallResult =>
    result.errorKind === "outcome_unknown" && result.requestKey !== undefined
      ? {
          ...failure(
            "write outcome unknown; inspect the original key",
            "outcome_unknown",
            "strict",
          ),
          requestKey: result.requestKey,
        }
      : proof.completed
        ? {
            ok: true,
            privacy: "strict",
            data: { completed: true, note: "completed; response withheld" },
            requestKey: result.requestKey,
          }
        : !result.ok && (proof.fixedRefusal || !proof.requireGuard)
          ? { ...result, privacy: "strict" }
          : failure(
              "the response was withheld because current access could not be verified",
              "privacy_check",
              "strict",
            );
  const check = (execution: NativePreparationExecution | undefined): NativeCallResult => {
    if (runtime.replaced() || stopped() || !execution) return withheld();
    if (spec && !enabledIn(spec, execution.policy.modules)) return withheld();
    const privacy = restrictivePrivacy(execution.policy.privacy, ceiling);
    if (privacy === "strict" && result.privacy !== "strict") return withheld();
    if (current && !current(execution)) return withheld();
    if (proof.requireGuard) {
      if (
        proof.guardInputs === undefined ||
        guardInputFingerprint(execution.context.guard) !== proof.guardInputs
      )
        return withheld();
    }
    return result;
  };
  try {
    // Actual host supplies hard read-only preparation. Sync-only compatibility runtimes get a
    // synchronous read callback over execute; it never runs a command or calls commit.
    return await (runtime.preparations
      ? runtime.preparations.execute(ceiling, check)
      : runtime.execute(ceiling, (execution) =>
          check(
            execution === undefined
              ? undefined
              : { context: execution.context, policy: execution.policy },
          ),
        ));
  } catch {
    warnNative(runtime, "mcp.delivery-withheld");
    return withheld();
  }
}
