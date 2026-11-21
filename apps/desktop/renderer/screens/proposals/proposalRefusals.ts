// The drawer's outcome messages and the text of the host's strategy / custom-rule preparation
// refusals (proposalsScreen.ts).

export type Message =
  | "refused"
  | "busy"
  | "baseChanged"
  | "ruleExists"
  | "ruleInvalid"
  | "strategyMissing"
  | "strategyUnreadable"
  | "invalidStrategy"
  | "rulesMadeInactive"
  | "notPending"
  | "authorityLost"
  | "cleanupFailed"
  | "unknown"
  | "recoveryAuthority"
  | "recoveryRestore"
  | "recoveryEvent"
  | "recoveryReconcile"
  | "failed"
  | "unavailableApproval"
  | null;

const STRATEGY_REFUSALS: Readonly<Record<string, Message>> = {
  base_changed: "baseChanged",
  rule_exists: "ruleExists",
  rule_invalid: "ruleInvalid",
  strategy_missing: "strategyMissing",
  strategy_unreadable: "strategyUnreadable",
  invalid_strategy: "invalidStrategy",
  rules_made_inactive: "rulesMadeInactive",
};

/** The message of a refused approval preparation: its own text for a strategy refusal. */
export const strategyRefusal = (reason: string): Message =>
  Object.hasOwn(STRATEGY_REFUSALS, reason) ? (STRATEGY_REFUSALS[reason] ?? "refused") : "refused";
