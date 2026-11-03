/** Review selection and statistics, independent of transport identities and UI language. */
import { addDays } from "../../dates.js";

export type ReviewCardId =
  | "world"
  | "sectors"
  | "positions"
  | "events"
  | "ideas"
  | "calendar"
  | "decide";
export const REVIEW_CARD_ORDER: readonly ReviewCardId[] = [
  "world",
  "sectors",
  "positions",
  "events",
  "ideas",
  "calendar",
  "decide",
];
export const REVIEW_MOVER_MIN = 0.03;
export function reviewBenchmarkStale(
  benchmark:
    | { readonly status: string; readonly covers_range_end?: boolean | null }
    | null
    | undefined,
): boolean {
  return benchmark?.status === "ok" && benchmark.covers_range_end === false;
}
export function reviewChangeSince(
  points: readonly {
    readonly date: string;
    readonly twr: number | null;
    readonly benchmark: number | null;
    readonly value: number | null;
    readonly flow?: number | null;
  }[],
  since: string,
) {
  let k = 0;
  points.forEach((point, i) => {
    if (point.date <= since) k = i;
  });
  const a = points[k],
    b = points.at(-1);
  if (points.length < 2 || !a || !b) return { pct: null, money: null, bench: null, from: null };
  const ratio = (x: number | null, y: number | null) =>
    x === null || y === null || x === -1 ? null : (1 + y) / (1 + x) - 1;
  const flows = points.slice(k + 1).reduce((sum, point) => sum + (point.flow ?? 0), 0);
  return {
    pct: ratio(a.twr, b.twr),
    money: a.value === null || b.value === null ? null : b.value - a.value - flows,
    bench: ratio(a.benchmark, b.benchmark),
    from: a.date,
  };
}
export function reviewWeeklySigma(
  points: readonly { readonly date: string; readonly twr: number | null }[],
): number | null {
  const pts = points.filter((p): p is { date: string; twr: number } => p.twr !== null);
  const returns: number[] = [];
  let j = 0;
  pts.forEach((point, i) => {
    const cut = addDays(point.date, -7);
    while (j + 1 < i && (pts[j + 1]?.date ?? "~") <= cut) j++;
    const base = pts[j];
    if (base && base.date <= cut && base.twr !== -1)
      returns.push((1 + point.twr) / (1 + base.twr) - 1);
  });
  if (returns.length < 40) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1));
  return sd > 0 ? sd : null;
}
export function reviewWorldVerdict(
  move: number | null,
  benchmark: number | null,
  sigma: number | null,
) {
  if (move === null) return { size: null, vs: null, down: false } as const;
  const z = Math.abs(move) / (sigma || 0.02);
  const diff = benchmark === null ? null : move - benchmark;
  return {
    size: z < 1 ? ("calm" as const) : z < 2 ? ("strong" as const) : ("rare" as const),
    vs:
      diff === null
        ? null
        : Math.abs(diff) < 0.01
          ? ("inline" as const)
          : diff < 0
            ? ("worse" as const)
            : ("better" as const),
    down: move < 0,
  };
}
export function reviewSectorRows<
  T extends { readonly contribution: number; readonly weight: number | null },
>(rows: readonly T[], unassigned: T | null, currency: T | null): T[] {
  const real = rows.filter((row) => (row.weight ?? 0) > 0 || row.contribution !== 0);
  if (unassigned && (unassigned.weight ?? 0) > 0) real.push(unassigned);
  real.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const result = real.slice(0, 6);
  if (currency && Math.abs(currency.contribution) >= 0.001) result.push(currency);
  return result;
}
export function reviewSectorVerdict(
  rows: readonly {
    readonly label: string;
    readonly contribution: number;
    readonly currency?: boolean;
  }[],
  move: number | null,
) {
  const real = rows.filter((row) => !row.currency),
    first = real[0];
  if (!first) return { code: "empty" as const, names: [], share: null, down: false };
  if (real.every((row) => row.contribution >= 0))
    return { code: "all_plus" as const, names: [first.label], share: null, down: false };
  if (real.every((row) => row.contribution <= 0))
    return { code: "all_minus" as const, names: [first.label], share: null, down: true };
  const sign = Math.sign(move ?? real.reduce((sum, row) => sum + row.contribution, 0)) || 1;
  const same = real.filter((row) => Math.sign(row.contribution) === sign),
    top = same.slice(0, 2);
  const share =
    top.reduce((sum, row) => sum + row.contribution, 0) /
    (same.reduce((sum, row) => sum + row.contribution, 0) || 1);
  return {
    code: share >= 0.6 ? ("share" as const) : ("spread" as const),
    names: top.map((row) => row.label),
    share,
    down: sign < 0,
  };
}
export function reviewMovers<
  T extends { readonly id: string | number; readonly ret: number; readonly contribution: number },
>(rows: readonly T[]) {
  const seen = new Map<string | number, T>();
  for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, row);
  const all = [...seen.values()].sort((a, b) => a.ret - b.ret);
  return {
    down: all.filter((row) => row.ret < 0).slice(0, 3),
    up: all
      .filter((row) => row.ret > 0)
      .reverse()
      .slice(0, 3),
    all,
  };
}
export function reviewEvents<T>(
  notes: readonly T[],
  facts: (note: T) => {
    readonly dismissed: boolean;
    readonly kind: string;
    readonly strength: number | null;
    readonly relation: string | null;
    readonly observedAt: string;
  },
) {
  const score: Readonly<Record<string, number>> = {
    invalidates: 3,
    weakens: 2,
    fulfills: 2,
    supports: 1,
  };
  return notes
    .flatMap((note) => {
      const f = facts(note);
      const priority = (f.strength ?? 1) + (score[f.relation ?? ""] ?? 0);
      return !f.dismissed &&
        ["news", "earnings", "macro", "trend"].includes(f.kind) &&
        priority >= 2
        ? [{ note, score: priority, observedAt: f.observedAt }]
        : [];
    })
    .sort((a, b) => b.score - a.score || b.observedAt.localeCompare(a.observedAt))
    .slice(0, 4)
    .map(({ note, score }) => ({ note, score }));
}
export function reviewIdeas<T>(
  notes: readonly T[],
  now: number,
  facts: (note: T) => {
    readonly kind: string;
    readonly dismissed: boolean;
    readonly accepted: boolean;
    readonly expired: boolean;
    readonly expiresAt: string | null;
    readonly observedAt: string;
  },
) {
  return notes
    .filter((note) => {
      const f = facts(note);
      return (
        f.kind === "candidate" &&
        !f.dismissed &&
        !f.accepted &&
        !f.expired &&
        (f.expiresAt === null || Date.parse(f.expiresAt) > now)
      );
    })
    .sort((a, b) => facts(b).observedAt.localeCompare(facts(a).observedAt))
    .slice(0, 3);
}
export function reviewCardMembership(
  input: {
    readonly sectors: boolean;
    readonly positions: boolean;
    readonly events: boolean;
    readonly ideas: boolean;
    readonly decide: boolean;
  },
  order: readonly ReviewCardId[] = REVIEW_CARD_ORDER,
) {
  const skips: Partial<Record<ReviewCardId, string>> = {};
  for (const key of ["sectors", "positions", "events", "ideas", "decide"] as const)
    if (!input[key]) skips[key] = `no_${key}`;
  return {
    cards: order.filter((id) => !skips[id]),
    skipped: order.flatMap((id) => (skips[id] ? [{ id, reason: skips[id] ?? "" }] : [])),
  };
}

export interface ReviewSignal<Id extends string | number = string> {
  readonly id: Id;
  readonly instrument: Id | null;
  readonly rule: string;
  readonly kind: string;
  readonly polarity: string;
  readonly relation: string | null;
  readonly firstSeen: number;
  readonly threshold: number;
  readonly open: boolean;
  readonly snoozed: boolean;
  readonly decided: boolean;
  readonly bucket: string | null;
}
export type ReviewDecideGroup = "risk" | "chance" | "mixed" | "plan" | "fix";
/** Stable subject membership and ladder selection. Labels and reasons remain in presentation adapters. */
export function reviewSignalSubjects<T extends ReviewSignal<string | number>>(
  signals: readonly T[],
  includeSnoozed = false,
): { key: string; instrument: T["instrument"]; live: T[]; ladder: T[] }[] {
  const by = new Map<string, T[]>();
  for (const signal of signals) {
    if (!signal.open || (!includeSnoozed && signal.snoozed) || signal.decided) continue;
    const key =
      signal.instrument !== null
        ? `i:${signal.instrument}`
        : signal.kind.startsWith("research:")
          ? `n:${signal.id}`
          : signal.kind === "allocation_drift"
            ? `b:${signal.bucket ?? ""}`
            : `r:${signal.rule}`;
    by.set(key, [...(by.get(key) ?? []), signal]);
  }
  return [...by].map(([key, rows]) => {
    const live: T[] = [],
      ladder: T[] = [];
    const kinds = new Map<string, T[]>();
    for (const row of rows) {
      if (!["drawdown_from_high", "loss_from_cost", "gain_from_cost"].includes(row.kind))
        live.push(row);
      else {
        const k = `${row.kind}|${row.polarity}`;
        kinds.set(k, [...(kinds.get(k) ?? []), row]);
      }
    }
    for (const steps of kinds.values()) {
      const [top, ...lower] = steps.sort(
        (a, b) => b.threshold - a.threshold || b.firstSeen - a.firstSeen,
      );
      if (top) live.push(top);
      ladder.push(...lower);
    }
    return { key, instrument: rows[0]?.instrument ?? null, live, ladder };
  });
}
export function reviewNewSince(since: number, now: number): number {
  return Math.max(Number.isFinite(since) ? since : now - 14 * 86400000, now - 14 * 86400000);
}
/** Shared reason selection for the deck and the carried-over Home rail. */
export function reviewDecideSelection<T extends ReviewSignal<string | number>>(
  signals: readonly T[],
  options: {
    readonly now: number;
    readonly since: number;
    readonly health: ReadonlyMap<T["instrument"], string>;
    readonly includeSnoozed?: boolean;
    readonly lastReviewAt?: number;
  },
) {
  const since = reviewNewSince(options.since, options.now),
    reviewed = options.lastReviewAt ?? Number.NaN;
  const research = (signal: T) => signal.kind.startsWith("research:");
  const wasInReview = (signal: T) =>
    Number.isFinite(reviewed) &&
    !research(signal) &&
    signal.firstSeen <= reviewed &&
    signal.firstSeen > reviewed - 14 * 86400000;
  const subjects = reviewSignalSubjects(
    signals.filter((signal) => options.includeSnoozed || !signal.snoozed),
    !!options.includeSnoozed,
  );
  type Subject = (typeof subjects)[number];
  const selected: {
    subject: Subject;
    changing: T | null;
    healthRelation: string | null;
    fresh: T[];
    isNew: boolean;
    newTag: boolean;
  }[] = [];
  const stale: T[] = [],
    rest = { review: 0, research: 0 };
  for (const subject of subjects) {
    const all = [...subject.live, ...subject.ladder];
    const changing =
      subject.live.find((signal) =>
        ["weakens", "invalidates", "fulfills"].includes(signal.relation ?? ""),
      ) ?? null;
    const healthRelation =
      changing === null && subject.instrument !== null
        ? (options.health.get(subject.instrument) ?? null)
        : null;
    const fresh = subject.live.filter((signal) => !research(signal) && signal.firstSeen > since);
    const carried = options.includeSnoozed
      ? subject.live.filter((signal) => signal.snoozed || wasInReview(signal))
      : [];
    const putOff =
      carried.length > 0 && (all.every((signal) => signal.snoozed) || carried.some(wasInReview));
    if (changing === null && healthRelation === null && fresh.length === 0 && !putOff) {
      const first = subject.live[0];
      if (
        subject.instrument === null &&
        first !== undefined &&
        !research(first) &&
        subject.live.every((signal) => options.now - signal.firstSeen > 14 * 86400000)
      )
        stale.push(...all);
      else if (subject.live.some((signal) => !research(signal) || signal.relation === "supports"))
        rest.review++;
      else rest.research++;
      continue;
    }
    selected.push({
      subject,
      changing,
      healthRelation,
      fresh: fresh.length ? fresh : carried,
      isNew:
        fresh.length > 0 ||
        (changing !== null && changing.firstSeen > since) ||
        healthRelation !== null,
      newTag: fresh.length > 0,
    });
  }
  return { selected, stale, rest };
}
export function reviewSubjectGroup(input: {
  readonly relation: string | null;
  readonly polarities: readonly string[];
  readonly hasExitPlan: boolean;
  readonly exitPlanChangedAt: number;
  readonly lastSeen: number;
}): ReviewDecideGroup {
  const pols = new Set(
    (input.relation
      ? [input.relation === "fulfills" ? "positive" : "negative"]
      : input.polarities
    ).filter((value) => value !== "neutral"),
  );
  if (input.hasExitPlan && input.exitPlanChangedAt > input.lastSeen + 86400000) return "plan";
  return pols.size === 1 ? (pols.has("negative") ? "risk" : "chance") : "mixed";
}
