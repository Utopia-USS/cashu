import { type UpdateStatus, updateStatus } from "@cashu/store/device";
import { type ChangeSource, defineQuery } from "@cashu/store/query";
import { z } from "zod";
import type { UiActionRegistration } from "./uiActions.js";

/** Production updater authority is injected by a packaged, verified runtime only. */
export interface UpdateProvider {
  readonly changes: ChangeSource;
  isCurrent(): boolean;
  status(): UpdateStatus;
  act(
    action: "check" | "install" | "skip" | "dismiss" | "auto",
    enabled?: boolean,
  ): Promise<{
    readonly kind: "completed" | "refused" | "outcome_unknown";
    readonly reason?: string;
  }>;
}

export function updateScreen(provider?: UpdateProvider) {
  const query = provider
    ? defineQuery({
        id: updateStatus.id,
        scope: "device",
        changes: provider.changes,
        run(_read, _args: { readonly poll: number }): UpdateStatus {
          if (!provider.isCurrent()) return { availability: "unavailable" };
          return provider.status();
        },
      })
    : updateStatus;
  const input = z.strictObject({
    action: z.enum(["check", "install", "skip", "dismiss", "auto"]),
    enabled: z.boolean().optional(),
  });
  const action: UiActionRegistration = {
    id: "device.updateAction",
    async run(_stores, _target, raw, sessionCurrent = () => true) {
      const parsed = input.safeParse(raw);
      if (!parsed.success || (parsed.data.action === "auto" && parsed.data.enabled === undefined))
        return { status: "refused", reason: "invalid_input", preparation: "none" };
      if (!provider?.isCurrent())
        return { status: "refused", reason: "capability_unavailable", preparation: "none" };
      if (!sessionCurrent())
        return { status: "refused", reason: "authority_lost", preparation: "none" };
      try {
        const outcome = await provider.act(parsed.data.action, parsed.data.enabled);
        if (!sessionCurrent() || !provider.isCurrent())
          return { status: "outcome_unknown", reason: "interrupted" };
        return { status: "completed", value: outcome };
      } catch {
        return { status: "outcome_unknown", reason: "unexpected_failure" };
      }
    },
  };
  return { query, action };
}
