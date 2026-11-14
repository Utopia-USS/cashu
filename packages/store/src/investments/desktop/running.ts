/**
 * Whether the host worker is refreshing this vault's quotes or running its daily rules check right now
 * (ab24ab6 v2/priceRefresh.ts `running` and v2/runState.ts from `GET /investments/run/status`). The
 * state lives only in the host process: the host binds this id to the worker's in-flight state and
 * re-runs it when a refresh or a run starts or ends. Unbound (no worker), nothing is running.
 */
import { defineQuery } from "../../query.js";

export interface InvestmentsRunning {
  /** A quote refresh for this vault is in flight (the Home's `odświeżam ceny`). */
  readonly prices: boolean;
  /** The daily rules / signals check of this vault is in flight (the Home's `reguły w toku`). */
  readonly rules: boolean;
}

export const NOTHING_RUNNING: InvestmentsRunning = { prices: false, rules: false };

export const investmentsRunning = defineQuery({
  id: "investments.desktop.running",
  run(_read, _args: undefined): InvestmentsRunning {
    return NOTHING_RUNNING;
  },
});
