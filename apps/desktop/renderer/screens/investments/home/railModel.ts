// The home rail's props (ab24ab6 v2/HomeRail.tsx SignalsBrief / AlertsBrief and research/Strip.tsx
// CandidatesRail, the logic part, laid out as design V5): the lead sentence, the rows grouped as new since the review
// (by category) or put off in it, the alert rows with the close / fired counts and the candidate rows, formatted
// here so HomeRailView stays pure. The review's own breakdown is the hero button's popover (reviewSlotModel.ts).
import { S } from "@cashu/i18n/investments/v2/HomeRail.strings";
import { S as C } from "@cashu/i18n/investments/v2/research/Strip.strings";
import type { RailRowData } from "@cashu/ui";
import { dm } from "@cashu/ui-logic/investments/labels";
import { type InstLike, instMono } from "@cashu/ui-logic/investments/v2/logic";
import { railAlerts, railSignals } from "@cashu/ui-logic/investments/v2/railLogic";
import {
  acceptedAt,
  candidateCriteria,
  criterionText,
  noteSubject,
  watchItemId,
} from "@cashu/ui-logic/investments/v2/research/logic";
import type { ResearchNote } from "@cashu/ui-logic/investments/v2/research/types";
import type { DecideGroup, DecideItem } from "@cashu/ui-logic/investments/v2/reviewDeckLogic";
import type { Alert, WatchItem } from "@cashu/ui-logic/investments/v2/types";
import type {
  AlertsBriefProps,
  CandidatesRailProps,
  RailGroup,
  SignalsBriefProps,
} from "./HomeRailView.js";

/** A subject without an instrument (a portfolio rule) gets the neutral Σ tile. */
const PORTFOLIO_MONO = "Σ";
const ROW_GROUPS: DecideGroup[] = ["risk", "chance", "mixed", "plan"];
/** The groups of new rows say they are new (the review counts everything, the rail lists what is new). */
const NEW_LABEL: Partial<Record<DecideGroup, () => string>> = {
  risk: () => S.newRisk,
  chance: () => S.newChance,
  mixed: () => S.newMixed,
  plan: () => S.newPlan,
};
const MAX_ROWS = 6;

const monoOf = (inst: InstLike | null) => (inst ? instMono(inst) : PORTFOLIO_MONO);

export interface SignalsBriefInput {
  items: readonly DecideItem[];
  total: number;
  loading: boolean;
  lastReviewAt: string | null;
  insts: Map<number, InstLike>;
  onOpenAsset(id: number): void;
  onAll(focusId: number | null): void;
}

export function signalsBriefProps(i: SignalsBriefInput): SignalsBriefProps {
  const { fresh, left } = railSignals([...i.items], i.lastReviewAt);
  const leftKeys = new Set(left.map((d) => d.key));
  // At most six rows; the rest is behind "Wszystkie".
  const shown = [...fresh, ...left].slice(0, MAX_ROWS);
  const freshKeys = new Set(fresh.map((d) => d.key));
  const shownFresh = shown.filter((d) => freshKeys.has(d.key) && ROW_GROUPS.includes(d.group));
  // Put off in the review (snoozed, or seen before it and still undecided): one group of their own.
  const shownOther = shown.filter((d) => leftKeys.has(d.key) && ROW_GROUPS.includes(d.group));
  const row = (d: DecideItem): RailRowData => {
    const inst =
      d.instrumentId != null
        ? (i.insts.get(d.instrumentId) ?? { id: d.instrumentId, label: d.title, name: d.title })
        : null;
    const note = d.snoozedUntil
      ? S.snoozedTo(dm(d.snoozedUntil))
      : leftKeys.has(d.key)
        ? S.undecided
        : null;
    return {
      key: d.key,
      monogram: monoOf(inst),
      portfolio: !inst,
      title: d.title,
      text: d.why,
      note,
      onOpen: () =>
        d.instrumentId != null ? i.onOpenAsset(d.instrumentId) : i.onAll(d.signalIds?.[0] ?? null),
    };
  };
  const groups: SignalsBriefProps["groups"] = [
    // New since the review, by category (the old rail grouped only these four categories, too).
    ...ROW_GROUPS.filter((g) => shownFresh.some((d) => d.group === g)).map((g) => ({
      group: g as RailGroup,
      label: NEW_LABEL[g]?.() ?? "",
      rows: shownFresh.filter((d) => d.group === g).map(row),
    })),
    ...(shownOther.length
      ? [{ group: "left" as RailGroup, label: S.putOff, rows: shownOther.map(row) }]
      : []),
  ];
  // No lead sentence and no unchanged count (design V5): the header, then the rows; the review's own counts are the
  // hero button's popover, every signal is behind All (n).
  return {
    loading: i.loading,
    groups,
    empty: groups.length ? null : S.nothingNew,
    all: S.all(i.total),
    allDisabled: !i.total,
    onAll: () => i.onAll(null),
  };
}

export interface AlertsBriefInput {
  alerts: Alert[] | null;
  near: { near_price_pct?: number | null; near_pp?: number | null } | null | undefined;
  sinceAt: string | null;
  onManage(): void;
}

export function alertsBriefProps(i: AlertsBriefInput): AlertsBriefProps {
  const all = i.alerts ?? [];
  const live = all.filter((a) => a.status === "active" || a.status === "triggered");
  const rows = railAlerts(
    all,
    i.near ? { pricePct: i.near.near_price_pct ?? null, pp: i.near.near_pp ?? null } : null,
    i.sinceAt,
  );
  return {
    loading: !i.alerts,
    counts: {
      close: S.closeN(rows.filter((r) => r.state === "near").length),
      fired: S.firedN(rows.filter((r) => r.state === "met").length),
    },
    empty: rows.length ? null : S.noneClose(live.length),
    rows: rows.map((r) => ({
      key: String(r.id),
      monogram: monoOf(r.inst),
      portfolio: !r.inst,
      title: r.title,
      note: r.extra,
      tag: r.tag,
      state: r.state,
      aria: S.stateAria(r.tag, r.state === "met" ? S.fired : S.close),
    })),
    all: S.all(live.length),
    onManage: i.onManage,
  };
}

/** Old research/index.tsx `watched`: the candidate's instrument is on the watchlist (or it was accepted). */
export function watchedOf(watch: readonly WatchItem[]) {
  return (n: ResearchNote): boolean => {
    const sym = (n.candidate?.symbol ?? n.instrument?.symbol)?.toUpperCase();
    const wid = watchItemId(n);
    const w = watch.find(
      (x) =>
        (wid != null && x.id === wid) ||
        (n.instrument_id != null && x.instrument_id === n.instrument_id) ||
        (sym && x.instrument?.symbol?.toUpperCase() === sym),
    );
    return !!w || !!acceptedAt(n);
  };
}

/** The candidate note's plain sentence: the agent's headline (or its brief's), else the context, else the met
 * criteria, else the title (older notes; it often just repeats the name). */
function noteSentence(n: ResearchNote): string {
  const d = n.details as Record<string, unknown> | null | undefined;
  const brief =
    d && typeof d.brief === "object" && d.brief
      ? (d.brief as Record<string, unknown>).headline
      : null;
  const head =
    typeof d?.headline === "string" ? d.headline : typeof brief === "string" ? brief : null;
  if (head?.trim()) return head.trim();
  if (typeof d?.context === "string" && d.context.trim()) return d.context.trim();
  const met = candidateCriteria(n)
    .items.filter((c) => c.met)
    .slice(0, 2)
    .map(criterionText);
  return met.length ? met.join(" · ") : n.title;
}

export interface CandidatesRailInput {
  candidates: readonly ResearchNote[] | undefined;
  watched(n: ResearchNote): boolean;
  why: number | null;
  busy: number | null;
  now: number;
  onWhy(id: number | null): void;
  onWatch(n: ResearchNote): void;
  onDismiss(n: ResearchNote): void;
  onAll(): void;
}

export function candidatesRailProps(i: CandidatesRailInput): CandidatesRailProps {
  // An expired candidate is gone: the agent gives each one 30 days and writes a fresh note when it still fits.
  const open = (i.candidates ?? []).filter(
    (n) => !n.dismissed_at && !n.expired && (!n.expires_at || Date.parse(n.expires_at) > i.now),
  );
  const fresh = open.filter((n) => !i.watched(n) && !acceptedAt(n) && watchItemId(n) == null);
  const shown = (fresh.length ? fresh : open).slice(0, 3);
  return {
    loading: i.candidates === undefined,
    lead: fresh.length > 0 ? C.candidatesLead(fresh.length) : null,
    all: open.length > 3 ? C.allCandidates(open.length) : null,
    onAll: i.onAll,
    rows: shown.map((n) => {
      const { name } = noteSubject(n);
      const crit = candidateCriteria(n);
      const context = typeof n.details?.context === "string" ? n.details.context : null;
      const why = crit.items.map((c) => `${c.met ? "✓" : "·"} ${criterionText(c)}`);
      if (context) why.push(context);
      if (!crit.total && !context) why.push(n.title);
      const symbol = n.instrument?.symbol ?? n.candidate?.symbol ?? null;
      return {
        row: {
          key: String(n.id),
          monogram: instMono({ label: name, name, symbol }),
          title: name,
          text: noteSentence(n),
        },
        noteId: n.id,
        name,
        whyOpen: i.why === n.id,
        watched: i.watched(n) || !!acceptedAt(n) || watchItemId(n) != null,
        busy: i.busy === n.id,
        why,
        onWhy: () => i.onWhy(i.why === n.id ? null : n.id),
        onWatch: () => i.onWatch(n),
        onDismiss: () => i.onDismiss(n),
      };
    }),
  };
}
