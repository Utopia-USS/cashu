/**
 * The ranked attention list: what in the profile needs a look now, at most `maxRows` rows ordered by
 * tier (1 money at risk this month, 2 a position, 4 a payee that changed) and size, plus one banner
 * for stale data or an ending bank consent (a banner, never a row). One currency at a time: bills and
 * payee changes in another currency are left out, never converted or compared. The one owner of the
 * payee yearly-effect threshold (`payeeChangeYearlyOfUsual`). Pure: every signal comes in as input.
 */

import type { IsoDate } from "../../dates.js";
import { D, type Decimal, ZERO } from "../../decimal.js";
import { ATTENTION_THRESHOLDS, type AttentionThresholds } from "./thresholds.js";

export interface AttentionAccount {
  readonly id: string;
  readonly name: string;
}

export interface AttentionInstrument {
  readonly id: string;
  readonly name: string;
}

export interface AttentionLargest {
  readonly payee: string;
  readonly date: IsoDate;
  readonly amount: Decimal;
}

export interface AttentionBill {
  readonly key: string;
  readonly payee: string;
  readonly when: IsoDate;
  readonly amount: Decimal;
  readonly currency: string;
  readonly account: AttentionAccount | null;
  readonly covered: boolean | null;
  readonly shortfall: Decimal | null;
}

export type ResearchVerdict = "supports" | "weakens" | "invalidates";

export interface AttentionPosition {
  readonly instrument: AttentionInstrument;
  /** Share of the portfolio (0.074 = 7.4 %). */
  readonly weight: number;
  readonly alert: { readonly severity: "action" | "info"; readonly title: string | null } | null;
  readonly research: { readonly verdict: ResearchVerdict } | null;
  /** `day`: the day's move as a share (-0.06 = -6 %); `weekSigma`: the week's move in standard deviations. */
  readonly move: { readonly day: number | null; readonly weekSigma: number | null } | null;
}

/** The part of a budget payee change the list reads (the budget module's `PayeeChange` fits it). */
export type AttentionPayeeChange =
  | {
      readonly kind: "price_up";
      readonly key: string;
      readonly payee: string;
      readonly currency: string;
      readonly from: Decimal;
      readonly to: Decimal;
      readonly yearlyEffect: Decimal;
      readonly nextDate: IsoDate;
    }
  | {
      readonly kind: "new_recurring";
      readonly key: string;
      readonly payee: string;
      readonly currency: string;
      readonly amount: Decimal;
      readonly cadenceDays: number;
    };

export interface AttentionInput {
  readonly today: IsoDate;
  readonly currency: string;
  readonly month: { readonly spentSoFar: Decimal; readonly usualMonth: Decimal | null };
  readonly uncategorized: {
    readonly count: number;
    readonly sum: Decimal;
    readonly largest: AttentionLargest | null;
  };
  readonly bills: readonly AttentionBill[];
  readonly positions: readonly AttentionPosition[];
  readonly payeeChanges: readonly AttentionPayeeChange[];
  readonly freshness: {
    readonly bankDataAgeHours: number | null;
    readonly consentEndsInDays: { readonly bank: string; readonly days: number } | null;
  };
}

export type AttentionReason =
  | {
      readonly kind: "uncategorized_sum";
      readonly sum: Decimal;
      readonly shareOfSpent: number;
      readonly count: number;
      readonly largest: AttentionLargest | null;
    }
  | {
      readonly kind: "bill_uncovered";
      readonly payee: string;
      readonly when: IsoDate;
      readonly shortfall: Decimal;
      readonly account: AttentionAccount | null;
    }
  | {
      readonly kind: "position";
      readonly instrument: AttentionInstrument;
      readonly alertFired: boolean;
      readonly researchVerdict: "weakens" | "invalidates" | null;
      readonly dayMove: number | null;
    }
  | {
      readonly kind: "payee_price_up";
      readonly payee: string;
      readonly from: Decimal;
      readonly to: Decimal;
      readonly yearlyEffect: Decimal;
      readonly nextDate: IsoDate;
    }
  | {
      readonly kind: "payee_new_recurring";
      readonly payee: string;
      readonly amount: Decimal;
      readonly cadenceDays: number;
    };

export type AttentionMagnitude =
  | {
      readonly kind: "money";
      readonly value: Decimal;
      readonly currency: string;
      readonly signed: boolean;
    }
  /** A share (0.31 = 31 %). */
  | { readonly kind: "percent"; readonly value: number };

export type AttentionTarget =
  | { readonly kind: "triage" }
  | { readonly kind: "bill"; readonly key: string }
  | { readonly kind: "position"; readonly instrument: string }
  | { readonly kind: "none" };

export interface AttentionItem {
  readonly tier: 1 | 2 | 4;
  readonly subject: {
    readonly kind: "uncategorized" | "bill" | "position" | "payee";
    readonly id: string;
  };
  readonly reason: AttentionReason;
  readonly magnitude: AttentionMagnitude;
  readonly target: AttentionTarget;
}

export type AttentionBanner =
  | { readonly kind: "stale"; readonly ageHours: number }
  | { readonly kind: "consent_ending"; readonly bank: string; readonly daysLeft: number };

export interface AttentionList {
  readonly rows: readonly AttentionItem[];
  readonly banner: AttentionBanner | null;
}

const share = (x: number): Decimal => D(String(x));

function uncategorizedRow(input: AttentionInput, t: AttentionThresholds): AttentionItem | null {
  const { sum, count, largest } = input.uncategorized;
  const { spentSoFar, usualMonth } = input.month;
  if (!spentSoFar.gt(ZERO) || usualMonth === null || !sum.gt(ZERO)) return null;
  if (sum.lt(spentSoFar.mul(share(t.uncategorizedShareOfSpent)))) return null;
  if (sum.lt(usualMonth.mul(share(t.uncategorizedFloorOfUsual)))) return null;
  const shareOfSpent = sum.div(spentSoFar).toFloat();
  return {
    tier: 1,
    subject: { kind: "uncategorized", id: "uncategorized" },
    reason: { kind: "uncategorized_sum", sum, shareOfSpent, count, largest },
    magnitude: { kind: "percent", value: shareOfSpent },
    target: { kind: "triage" },
  };
}

function billRow(bill: AttentionBill, currency: string): AttentionItem | null {
  if (bill.currency !== currency || bill.covered !== false || bill.shortfall === null) return null;
  return {
    tier: 1,
    subject: { kind: "bill", id: bill.key },
    reason: {
      kind: "bill_uncovered",
      payee: bill.payee,
      when: bill.when,
      shortfall: bill.shortfall,
      account: bill.account,
    },
    magnitude: { kind: "money", value: bill.shortfall, currency, signed: false },
    target: { kind: "bill", key: bill.key },
  };
}

function positionRow(p: AttentionPosition, t: AttentionThresholds): AttentionItem | null {
  const alertFired = p.alert?.severity === "action";
  const verdict = p.research?.verdict;
  const researchVerdict = verdict === "weakens" || verdict === "invalidates" ? verdict : null;
  const day = p.move?.day ?? null;
  const weekSigma = p.move?.weekSigma ?? null;
  const moved =
    (day !== null && Math.abs(day) >= t.positionDayMove) ||
    (weekSigma !== null && Math.abs(weekSigma) >= t.positionWeekSigma);
  if (!alertFired && !(p.weight >= t.positionWeight && (researchVerdict !== null || moved))) {
    return null;
  }
  return {
    tier: 2,
    subject: { kind: "position", id: p.instrument.id },
    reason: {
      kind: "position",
      instrument: p.instrument,
      alertFired,
      researchVerdict,
      dayMove: day,
    },
    magnitude: { kind: "percent", value: p.weight },
    target: { kind: "position", instrument: p.instrument.id },
  };
}

function payeeRow(
  c: AttentionPayeeChange,
  input: AttentionInput,
  t: AttentionThresholds,
): AttentionItem | null {
  if (c.currency !== input.currency) return null;
  const subject = { kind: "payee", id: c.key } as const;
  if (c.kind === "new_recurring") {
    return {
      tier: 4,
      subject,
      reason: {
        kind: "payee_new_recurring",
        payee: c.payee,
        amount: c.amount,
        cadenceDays: c.cadenceDays,
      },
      magnitude: { kind: "money", value: c.amount, currency: c.currency, signed: false },
      target: { kind: "none" },
    };
  }
  const usual = input.month.usualMonth;
  if (usual === null || c.yearlyEffect.lt(usual.mul(share(t.payeeChangeYearlyOfUsual)))) {
    return null;
  }
  return {
    tier: 4,
    subject,
    reason: {
      kind: "payee_price_up",
      payee: c.payee,
      from: c.from,
      to: c.to,
      yearlyEffect: c.yearlyEffect,
      nextDate: c.nextDate,
    },
    magnitude: { kind: "money", value: c.yearlyEffect, currency: c.currency, signed: true },
    target: { kind: "none" },
  };
}

/** Within a tier: money before shares, each larger first, then by subject id. */
function compareItems(a: AttentionItem, b: AttentionItem): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const am = a.magnitude;
  const bm = b.magnitude;
  if (am.kind !== bm.kind) return am.kind === "money" ? -1 : 1;
  const bySize =
    am.kind === "money" && bm.kind === "money"
      ? bm.value.compare(am.value)
      : am.kind === "percent" && bm.kind === "percent"
        ? bm.value - am.value
        : 0;
  if (bySize !== 0) return bySize;
  return a.subject.id < b.subject.id ? -1 : a.subject.id > b.subject.id ? 1 : 0;
}

function banner(input: AttentionInput, t: AttentionThresholds): AttentionBanner | null {
  const { bankDataAgeHours, consentEndsInDays } = input.freshness;
  if (bankDataAgeHours !== null && bankDataAgeHours >= t.staleAfterHours) {
    return { kind: "stale", ageHours: bankDataAgeHours };
  }
  if (consentEndsInDays !== null && consentEndsInDays.days <= t.consentWarnDays) {
    return {
      kind: "consent_ending",
      bank: consentEndsInDays.bank,
      daysLeft: consentEndsInDays.days,
    };
  }
  return null;
}

/** The attention rows (at most `t.maxRows`) and the banner. */
export function rankAttention(
  input: AttentionInput,
  t: AttentionThresholds = ATTENTION_THRESHOLDS,
): AttentionList {
  const candidates: (AttentionItem | null)[] = [
    uncategorizedRow(input, t),
    ...input.bills.map((b) => billRow(b, input.currency)),
    ...input.positions.map((p) => positionRow(p, t)),
    ...input.payeeChanges.map((c) => payeeRow(c, input, t)),
  ];
  const rows = candidates
    .filter((r): r is AttentionItem => r !== null)
    .sort(compareItems)
    .slice(0, t.maxRows);
  return { rows, banner: banner(input, t) };
}
