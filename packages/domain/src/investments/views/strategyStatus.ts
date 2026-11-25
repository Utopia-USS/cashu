/** Native strategy read projection; file existence/paths are supplied by the authorized file port. */

import type { UiLang } from "../../core/i18n.js";
import { utcIso } from "../../dates.js";
import type { Currency } from "../domain/index.js";
import {
  issueRecord,
  type StrategyIssue,
  type StrategyStatus,
  usableConfig,
} from "../strategy/index.js";
import { strategyStatusStrings } from "./strategyStatus.strings.js";

export interface StrategyVersionFact {
  readonly version: number;
  readonly state: string;
  readonly createdAt: string;
  readonly sha256: string;
  readonly issues: readonly unknown[];
}
export interface StrategyFileFacts {
  readonly yaml: string;
  readonly md: string;
  readonly yamlExists: boolean;
  readonly mdExists: boolean;
}

export function strategyBrief(status: StrategyStatus) {
  const issues = status.result?.issues ?? [];
  const errors = issues.filter((i) => i.severity === "error").length;
  return {
    state: status.state,
    version: status.latest?.version ?? null,
    changed: status.changed,
    errors: errors + (status.readError === null ? 0 : 1),
    warnings: issues.length - errors,
    inactive_rules: status.result?.inactiveRules.length ?? 0,
  };
}

export function strategyStatusView(input: {
  readonly status: StrategyStatus;
  readonly profileBase: Currency;
  readonly files: StrategyFileFacts;
  readonly versions: readonly StrategyVersionFact[];
  readonly lang: UiLang;
}) {
  const config = usableConfig(input.status);
  const issues = input.status.result?.issues ?? [];
  const record = (issue: StrategyIssue) => issueRecord(issue);
  const facts =
    config === null
      ? null
      : {
          base_currency: config.baseCurrency,
          buckets: config.allocation.buckets.map((b) => b.id),
          targets: Object.fromEntries(config.allocation.targets),
          rules: config.rules.map((r) => ({
            id: r.id,
            kind: r.kind,
            severity: r.severity,
            cooldown_days: r.cooldownDays,
          })),
          horizon_years: config.horizonYears,
          contributions:
            config.contributions === null
              ? null
              : {
                  monthly_amount: config.contributions.monthlyAmount,
                  day_of_month: config.contributions.dayOfMonth,
                },
          notifications: {
            immediate: [...config.notifications.immediate].sort(),
            digest_weekday: config.notifications.digestWeekday,
          },
          bucket_matches: config.allocation.buckets.map((b) => ({
            id: b.id,
            asset_class: [...b.match.assetClasses].sort(),
            tags: [...b.match.tags].sort(),
            mic: [...b.match.mics].sort(),
            currency: [...b.match.currencies].sort(),
            instrument_ids: [...b.match.instrumentIds].sort(),
          })),
        };
  return {
    ...strategyBrief(input.status),
    files: {
      yaml: input.files.yaml,
      md: input.files.md,
      yaml_exists: input.files.yamlExists,
      md_exists: input.files.mdExists,
    },
    read_error: input.status.readError,
    issues: issues.map(record),
    inactive_rules: (input.status.result?.inactiveRules ?? []).map((r) => ({
      index: r.index,
      rule_id: r.ruleId,
      kind: r.kind,
      line: r.line,
      issues: r.issues.map(record),
    })),
    facts,
    base_currency_note:
      config !== null && config.baseCurrency !== input.profileBase
        ? strategyStatusStrings.baseMismatch[input.lang](config.baseCurrency, input.profileBase)
        : null,
    versions: input.versions.map((v) => ({
      version: v.version,
      state: v.state,
      created_at: utcIso(v.createdAt),
      sha256: v.sha256,
      issues: v.issues.length,
    })),
  };
}
