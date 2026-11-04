import type { UiAction } from "../ui-actions.js";

export type BankingSettingsInput =
  | { readonly type: "status" | "check" | "banks" | "cancelConsent" | "sync" }
  | { readonly type: "beginConsent"; readonly aspsp: string }
  | { readonly type: "completeConsent"; readonly callbackUrl?: string }
  | { readonly type: "forgetSession"; readonly handle: string }
  | { readonly type: "attemptStatus"; readonly key: string };

/** Store channel descriptor only; the host owns every implementation and bank secret. */
export const bankingSettings: UiAction<BankingSettingsInput, unknown> = {
  id: "core.settings.banking",
};
