// Python dataclass output and payload numeric types for the pure rules check.
import { Decimal, unicodeDecimal } from "@cashu/domain";
import type { RuleOutcome } from "@cashu/domain/investments/rules";
import type { PythonDb } from "../../sources/index.ts";
import { type OutValue, pyFloat } from "../output.ts";

type RuleIds = Pick<PythonDb, "keys">;

const INTEGER_FIELDS = new Set([
  "accounts",
  "scopes",
  "window_days",
  "period_days",
  "grace_days",
  "day_of_month",
  "days_since_last_deposit",
]);

function rowId(value: string | number): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (!value || value.startsWith("0")) return null;
  const digits = Array.from(value, (char) => unicodeDecimal(char.codePointAt(0) ?? 0));
  if (digits.some((digit) => digit < 0)) return null;
  const id = Number(digits.join(""));
  if (!Number.isSafeInteger(id)) throw new Error("unsafe numeric rule payload identifier");
  return id;
}

function payload(value: unknown, ids: RuleIds, field = "", parent = ""): OutValue {
  if (value === null || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => payload(item, ids, field, parent));
  const identifier = field === "id" || field.endsWith("_id") || field.endsWith("_ids");
  if (identifier && (typeof value === "string" || typeof value === "number")) {
    const id = rowId(value);
    if (id !== null) {
      if (/^(?:.*_)?account_ids?$/.test(field)) return ids.keys.key("accounts", id);
      if (
        /^(?:.*_)?instrument_ids?$/.test(field) ||
        (field === "id" && ["instrument", "instruments"].includes(parent))
      )
        return ids.keys.key("inv_instruments", id);
      if (field === "profile_id") return ids.keys.key("profiles", id);
      throw new Error(`unmapped numeric rule payload identifier: ${field}`);
    }
  }
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (INTEGER_FIELDS.has(field)) {
      if (!Number.isSafeInteger(value)) throw new Error(`non-integer rule count: ${field}`);
      return BigInt(value);
    }
    return pyFloat(value);
  }
  if (value instanceof Decimal) return value;
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, payload(item, ids, key, field)]),
    );
  }
  throw new Error("unsupported rule payload value");
}

export function ruleIdentifier(value: string, ids: RuleIds): OutValue {
  return payload(value, ids, "rule_id");
}

export function ruleOutcome(outcome: RuleOutcome, ids: RuleIds): OutValue {
  if (outcome.type === "fired") {
    const c = outcome.candidate;
    return {
      type: "Fired",
      outcome: {
        candidate: {
          rule_id: ruleIdentifier(c.ruleId, ids),
          kind: c.kind,
          dedup_key: c.dedupKey,
          severity: c.severity,
          message: c.message,
          instrument_id: payload(c.instrumentId, ids, "instrument_id"),
          account_id: payload(c.accountId, ids, "account_id"),
          payload: payload(c.payload, ids),
          polarity: c.polarity,
        },
      },
    };
  }
  if (outcome.type === "not_fired") {
    return {
      type: "NotFired",
      outcome: {
        rule_id: ruleIdentifier(outcome.ruleId, ids),
        dedup_key: outcome.dedupKey,
        details: payload(outcome.details, ids),
      },
    };
  }
  return {
    type: "Skipped",
    outcome: {
      rule_id: ruleIdentifier(outcome.ruleId, ids),
      reason: outcome.reason,
      dedup_key: outcome.dedupKey,
    },
  };
}
