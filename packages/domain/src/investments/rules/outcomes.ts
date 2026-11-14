/** Pure findings and checked scopes consumed by the lifecycle; persistence lives in the store. */
import type { SignalSeverity } from "../domain/enums.js";
import type { AccountId, InstrumentId } from "../domain/values.js";
import type { RuleSpec } from "./config.js";
import { SignalPolarity } from "./polarity.js";

export interface SignalCandidate {
  readonly ruleId: string;
  readonly kind: string;
  readonly dedupKey: string;
  readonly severity: SignalSeverity;
  readonly message: string;
  readonly instrumentId: InstrumentId | null;
  readonly accountId: AccountId | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly polarity: SignalPolarity;
}
export class Fired {
  readonly type = "fired";
  readonly candidate: SignalCandidate;
  constructor(candidate: SignalCandidate) {
    this.candidate = candidate;
  }
  get ruleId(): string {
    return this.candidate.ruleId;
  }
  get dedupKey(): string {
    return this.candidate.dedupKey;
  }
}
export class NotFired {
  readonly type = "not_fired";
  readonly ruleId: string;
  readonly dedupKey: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(
    ruleId: string,
    dedupKey: string | null = null,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    this.ruleId = ruleId;
    this.dedupKey = dedupKey;
    this.details = details;
  }
}
export class Skipped {
  readonly type = "skipped";
  readonly ruleId: string;
  readonly reason: string;
  readonly dedupKey: string | null;
  constructor(ruleId: string, reason: string, dedupKey: string | null = null) {
    this.ruleId = ruleId;
    this.reason = reason;
    this.dedupKey = dedupKey;
  }
}
export type RuleOutcome = Fired | NotFired | Skipped;
export function signalDedupKey(
  ruleId: string,
  options: {
    readonly instrumentId?: InstrumentId | null;
    readonly accountId?: AccountId | null;
    readonly scope?: string | null;
  } = {},
): string {
  const parts = [ruleId];
  if (options.instrumentId != null) parts.push(`i:${options.instrumentId}`);
  if (options.accountId != null) parts.push(`a:${options.accountId}`);
  if (options.scope != null) parts.push(`s:${options.scope}`);
  return parts.join("|");
}
export function outcomeScope(outcome: RuleOutcome): string | null {
  return outcome.dedupKey;
}
/** All defaults are explicit so native parity and later lifecycle see the same candidate shape. */
export function candidate(
  spec: RuleSpec,
  key: string,
  message: string,
  payload: Readonly<Record<string, unknown>>,
  instrumentId: InstrumentId | null = null,
  accountId: AccountId | null = null,
): SignalCandidate {
  return {
    ruleId: spec.id,
    kind: spec.kind,
    dedupKey: key,
    severity: spec.severity,
    message,
    instrumentId,
    accountId,
    payload,
    polarity: SignalPolarity.NEUTRAL,
  };
}
