import { enabledModuleIds } from "@cashu/store/core";
import { z } from "zod";
import { refreshFetchAuthority } from "../fetchAuthority.js";
import type { UiActionRegistration } from "../uiActions.js";
import { reportSuccessfulFetch } from "../worker/leaseReport.js";
import { runBankingOwnerAction } from "./ownerAction.js";
import type { BankingRuntime } from "./runtime.js";

const publicAction = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status") }),
  z.strictObject({ type: z.literal("check") }),
  z.strictObject({ type: z.literal("unconfigure") }),
  z.strictObject({ type: z.literal("banks") }),
  z.strictObject({ type: z.literal("beginConsent"), aspsp: z.string().min(1).max(256) }),
  z.strictObject({
    type: z.literal("completeConsent"),
    callbackUrl: z.string().max(4096).optional(),
  }),
  z.strictObject({
    type: z.literal("offerCallback"),
    callbackUrl: z.string().min(1).max(4096),
  }),
  z.strictObject({ type: z.literal("cancelConsent") }),
  z.strictObject({ type: z.literal("sync") }),
  z.strictObject({ type: z.literal("forgetSession"), handle: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ type: z.literal("attemptStatus"), key: z.string().regex(/^[a-f0-9]{32}$/) }),
]);

/** Owner-only native banking controls. The UI action carries no PEM, key path or session id. */
export function bankingUiAction(runtime: () => BankingRuntime | undefined): UiActionRegistration {
  return {
    id: "core.settings.banking",
    async run(stores, vaultId, action, sessionCurrent = () => true) {
      const parsed = publicAction.safeParse(action);
      if (!parsed.success)
        return { status: "refused", reason: "invalid_input", preparation: "none" };
      const vault = stores.vaults.get(vaultId);
      if (
        vault?.mode !== "native" ||
        !enabledModuleIds(vault.store.read.bind(vault.store)).has("budget")
      )
        return { status: "not_started", reason: "capability_unavailable" };
      const current = () =>
        sessionCurrent() && stores.vaults.get(vaultId) === vault && vault.native.isCurrent();
      if (!current()) return { status: "refused", reason: "stale_action", preparation: "none" };
      const active = runtime();
      if (!active) return { status: "not_started", reason: "capability_unavailable" };
      // A bank sync is a fetch-leader action: obtain fresh pull evidence before it starts.
      if (parsed.data.type === "sync") await refreshFetchAuthority(vault);
      const endFetch = parsed.data.type === "sync" ? vault.native.beginFetch() : null;
      if (parsed.data.type === "sync" && !endFetch)
        return { status: "not_started", reason: "capability_unavailable" };
      let result: Awaited<ReturnType<typeof runBankingOwnerAction>>;
      try {
        result = await active.withOwnerAction(vaultId, current, () =>
          runBankingOwnerAction({
            runtime: active,
            profileId: vaultId,
            isOwnerAction: current,
            action: parsed.data,
          }),
        );
      } finally {
        endFetch?.();
      }
      if (
        parsed.data.type === "sync" &&
        result.ok &&
        typeof result.value === "object" &&
        result.value !== null
      ) {
        const sync = result.value as { banks?: unknown; attempts?: unknown };
        if (
          typeof sync.banks === "number" &&
          sync.banks > 0 &&
          Array.isArray(sync.attempts) &&
          sync.attempts.length === 0
        )
          await reportSuccessfulFetch(vault, current);
      }
      return !current()
        ? { status: "outcome_unknown", reason: "interrupted" }
        : result.ok
          ? { status: "completed", value: result.value }
          : result.error === "outcome_unknown"
            ? { status: "outcome_unknown", reason: "interrupted" }
            : { status: "refused", reason: result.error, preparation: "none" };
    },
  };
}
