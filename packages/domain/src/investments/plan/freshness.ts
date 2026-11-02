/** Recommendation freshness (P3), evaluated from stored facts at an explicit exact UTC instant. */
import { type DateTime, toUtc } from "../../dates.js";
import { BUY_PLANS, HELD_ONLY_PLANS } from "../domain/index.js";
import type { ScoredNote } from "../research/index.js";
import {
  activeAt,
  CANDIDATE_KIND,
  Health,
  type Instant,
  MICROS_PER_DAY,
  noteWeight,
  storedAt,
  utcInstant,
  windowNotes,
} from "../research/index.js";
export interface FreshnessNote {
  readonly id: string;
  readonly scored: ScoredNote;
}

export const PLAN_MAX_AGE_DAYS = 30;
export const STRATEGY_RULE_KINDS = [
  "gain_from_cost",
  "loss_from_cost",
  "drawdown_from_high",
  "position_concentration",
] as const;
export const FreshnessState = {
  FRESH: "fresh",
  MAYBE_OUTDATED: "maybe_outdated",
  OUTDATED: "outdated",
} as const;
export type FreshnessState = (typeof FreshnessState)[keyof typeof FreshnessState];
export const FreshnessReasonCode = {
  NOTE_INVALIDATES: "note_invalidates",
  THESIS_INVALIDATED: "thesis_invalidated",
  FULFILLED_BUY: "fulfilled_buy",
  NOTE_AFTER: "note_after",
  THESIS_CHANGED: "thesis_changed",
  RULE_FIRED: "rule_fired",
  ALERT_TRIGGERED: "alert_triggered",
  AGE: "age",
} as const;
export type FreshnessReasonCode = (typeof FreshnessReasonCode)[keyof typeof FreshnessReasonCode];
export const OUTDATED_CODES: readonly FreshnessReasonCode[] = [
  "note_invalidates",
  "thesis_invalidated",
  "fulfilled_buy",
];
export const REASON_ORDER: readonly FreshnessReasonCode[] = [
  ...OUTDATED_CODES,
  "note_after",
  "thesis_changed",
  "rule_fired",
  "alert_triggered",
  "age",
];
/** Order is request-local canonical creation order supplied by the adapter, never a SQL id. */
export interface PlanSignal {
  readonly signalId: string;
  readonly kind: string;
  readonly firstSeenAt: Instant;
  readonly order: number;
}
export interface PlanAlert {
  readonly alertId: string;
  readonly kind: string;
  readonly triggeredAt: Instant;
  readonly order: number;
}
export interface FreshnessFacts {
  readonly plan: string | null;
  readonly planAt: Instant | null;
  readonly health?: string;
  readonly notes?: readonly FreshnessNote[];
  readonly coreChangedAt?: Instant | null;
  readonly signals?: readonly PlanSignal[];
  readonly alerts?: readonly PlanAlert[];
}
export interface FreshnessReason {
  readonly code: FreshnessReasonCode;
  readonly at: Instant | null;
  readonly noteId?: string;
  readonly signalId?: string;
  readonly alertId?: string;
  readonly kind?: string;
  readonly relation?: string;
  readonly count?: number;
}
export class Freshness {
  readonly state: FreshnessState;
  readonly reasons: readonly FreshnessReason[];
  constructor(state: FreshnessState, reasons: readonly FreshnessReason[] = []) {
    this.state = state;
    this.reasons = reasons;
  }
  get codes(): readonly FreshnessReasonCode[] {
    return [...new Set(this.reasons.map((r) => r.code))];
  }
}
/** Reuse the existing UTC/date and research-instant adapters rather than approximate epoch numbers. */
export function planInstant(value: DateTime): Instant {
  const d = toUtc(value);
  return utcInstant(d.date, d.hour, d.minute, d.second, d.microsecond);
}
function newest(notes: readonly FreshnessNote[]): FreshnessNote | undefined {
  return notes.reduce<FreshnessNote | undefined>(
    (best, n) =>
      best === undefined ||
      n.scored.createdAt > best.scored.createdAt ||
      (n.scored.createdAt === best.scored.createdAt && n.scored.id > best.scored.id)
        ? n
        : best,
    undefined,
  );
}
function noteReason(
  code: FreshnessReasonCode,
  notes: readonly FreshnessNote[],
): FreshnessReason | null {
  const n = newest(notes);
  return n === undefined
    ? null
    : {
        code,
        at: n.scored.createdAt,
        noteId: n.id,
        relation: n.scored.thesisRelation,
        count: notes.length,
      };
}
function after(note: FreshnessNote): boolean {
  const n = note.scored,
    w = noteWeight(n.kind, n.strength);
  return (
    n.thesisRelation === "weakens" ||
    n.thesisRelation === "fulfills" ||
    (n.thesisRelation === "supports" && w >= 2) ||
    w >= 3
  );
}
export function planFreshness(f: FreshnessFacts, now: Instant): Freshness | null {
  if (f.plan === null || f.planAt === null) return null;
  const planAt = f.planAt,
    notes = f.notes ?? [],
    reasons: FreshnessReason[] = [];
  const stored = notes.filter(
    (n) =>
      n.scored.kind !== CANDIDATE_KIND && storedAt(n.scored, now) && n.scored.createdAt > planAt,
  );
  const invalidating = stored.filter((n) => n.scored.thesisRelation === "invalidates");
  const fulfilling = BUY_PLANS.has(f.plan)
    ? stored.filter((n) => n.scored.thesisRelation === "fulfills")
    : [];
  for (const [code, group] of [
    ["note_invalidates", invalidating],
    ["fulfilled_buy", fulfilling],
  ] as const) {
    const r = noteReason(code, group);
    if (r !== null) reasons.push(r);
  }
  if (!invalidating.length && f.health === Health.INVALIDATED && !HELD_ONLY_PLANS.has(f.plan)) {
    const eligible = new Set(
      windowNotes(
        notes.map((n) => n.scored),
        now,
      )
        .filter((n) => n.thesisRelation === "invalidates")
        .map((n) => n.id),
    );
    const n = newest(notes.filter((n) => eligible.has(n.scored.id)));
    reasons.push({
      code: "thesis_invalidated",
      at: n?.scored.createdAt ?? null,
      ...(n === undefined ? {} : { noteId: n.id }),
    });
  }
  const counted = new Set([...invalidating, ...fulfilling].map((n) => n.id));
  const noteAfter = noteReason(
    "note_after",
    stored.filter((n) => !counted.has(n.id) && activeAt(n.scored, now) && after(n)),
  );
  if (noteAfter !== null) reasons.push(noteAfter);
  if (f.coreChangedAt != null && f.coreChangedAt > planAt)
    reasons.push({ code: "thesis_changed", at: f.coreChangedAt });
  for (const kind of STRATEGY_RULE_KINDS) {
    const fired = (f.signals ?? []).filter((s) => s.kind === kind && s.firstSeenAt > planAt);
    const s = fired.reduce<PlanSignal | undefined>(
      (best, s) =>
        best === undefined ||
        s.firstSeenAt > best.firstSeenAt ||
        (s.firstSeenAt === best.firstSeenAt && s.order > best.order)
          ? s
          : best,
      undefined,
    );
    if (s !== undefined)
      reasons.push({ code: "rule_fired", at: s.firstSeenAt, signalId: s.signalId, kind });
  }
  for (const a of [...(f.alerts ?? [])].sort((a, b) => a.order - b.order))
    if (a.triggeredAt > planAt)
      reasons.push({
        code: "alert_triggered",
        at: a.triggeredAt,
        alertId: a.alertId,
        kind: a.kind,
      });
  const agedAt = planAt + BigInt(PLAN_MAX_AGE_DAYS) * MICROS_PER_DAY;
  if (now > agedAt) reasons.push({ code: "age", at: agedAt });
  reasons.sort((a, b) => {
    const ar = REASON_ORDER.indexOf(a.code),
      br = REASON_ORDER.indexOf(b.code);
    if (ar !== br) return ar - br;
    const at = a.at ?? 0n,
      bt = b.at ?? 0n;
    return at > bt ? -1 : at < bt ? 1 : 0;
  });
  return new Freshness(
    reasons.some((r) => OUTDATED_CODES.includes(r.code))
      ? "outdated"
      : reasons.length
        ? "maybe_outdated"
        : "fresh",
    reasons,
  );
}
