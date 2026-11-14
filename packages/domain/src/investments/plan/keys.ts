import type { InstrumentId } from "../domain/index.js";

export const PLAN_PREFIX = "plan:";
export const isPlanKey = (value: string | null): boolean => value?.startsWith(PLAN_PREFIX) ?? false;
export const planRuleId = (check: string): string => `${PLAN_PREFIX}${check}`;
export const planDedupKey = (check: string, instrument: InstrumentId): string =>
  `${planRuleId(check)}|i:${instrument}`;
