// Investments payload shapes the shared UI logic reads (they mirror service/views.py; transport in the app's api.ts).
// Money is a JSON number next to its currency, weights are fractions. Types only.

export interface Decision {
  id: number;
  signal_id: number | null;
  instrument_id: number | null;
  account_id: number | null;
  action: string; // bought | sold | held | ignored | other
  quantity: Num;
  price: Num;
  currency: string | null;
  reason: string | null;
  created_at: string | null;
  /** Every signal the decision answers (position decisions link several; F9 BE). Older servers: absent. */
  signal_ids?: number[];
}

/** P3 one reason a recommendation may be outdated: `at` = when it happened (UTC ISO); note reasons carry the newest
 * note, its relation and how many notes qualify; rule / alert reasons the signal / alert id and the kind. */
export interface FreshReason {
  code: string;
  at: string | null;
  note_id?: number | null;
  relation?: string | null;
  count?: number | null;
  signal_id?: number | null;
  alert_id?: number | null;
  kind?: string | null;
}

/** P2 strategy hint: which of the owner's own rules apply now (BE decides code, severity and order, main first).
 * Params are fractions as in the rules (0.27 = 27 %). */
export interface Hint {
  code: string;
  severity: "rule" | "review" | "info" | string;
  params: Record<string, unknown>;
}

export type Num = number | null;

export interface PlanFreshness {
  state: "fresh" | "maybe_outdated" | "outdated" | string;
  reasons: FreshReason[];
}

export interface Signal {
  id: number;
  rule_id: string;
  kind: string;
  dedup_key: string;
  severity: "info" | "action" | string;
  status: "active" | "acknowledged" | "resolved" | "expired" | string;
  message: string;
  instrument_id: number | null;
  instrument_label: string | null;
  account_id: number | null;
  payload: Record<string, unknown>;
  first_seen_at: string | null;
  last_seen_at: string | null;
  acknowledged_at: string | null;
  closed_at: string | null;
  /** "Odłóż do" (track AL, F5 R7): hidden from the to-do list while `snoozed`. */
  snoozed_until?: string | null;
  snoozed?: boolean;
  decisions: Decision[];
}

export interface StrategyDoc {
  id: string;
  main: boolean;
  executed: boolean;
  title: string | null;
  status: string | null;
  description: string | null;
  main_file: string | null;
  /** Absolute folder the file paths are relative to. */
  root: string;
  files: StrategyDocFile[];
  /** `_main` only: the validation brief of the executed strategy. */
  brief?: {
    state: string;
    version: number | null;
    changed: boolean;
    errors: number;
    warnings: number;
    inactive_rules: number;
  };
}

/** One strategy of the Strategie tab (docs/agents/strategies.md): `_main` is the executed strategy.md / .yaml. */
export interface StrategyDocFile {
  path: string;
  kind: "md" | "yaml" | "text";
}
