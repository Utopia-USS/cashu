// The shared formatting of the ported Signals code (ab24ab6 v2/Signals.tsx helpers): the dialog's context
// (old SignalsCtx without its callbacks), a signal's age (`dziś` / `2.10`, unconfirmed in the warn colour), its
// one-fact line and the long form of its tooltip, the instrument behind a signal, the thesis line, the decision
// form's default action and the research effect line (research/ReviewBlock.tsx researchEffectLine). Pure.
import { S as R } from "@cashu/i18n/investments/v2/research/ReviewBlock.strings";
import { S } from "@cashu/i18n/investments/v2/Signals.strings";
import type { InstCardProps } from "@cashu/ui";
import { localDay, parseServerTime } from "@cashu/ui-logic/core/time";
import { dm, ENTRY_TYPE } from "@cashu/ui-logic/investments/labels";
import type {
  AccountRow,
  BucketRow,
  Decision,
  Hint,
  Thesis,
} from "@cashu/ui-logic/investments/types";
import {
  type InstLike,
  instName,
  isDecided,
  type SigFact,
  signalCurrent,
  signalText,
} from "@cashu/ui-logic/investments/v2/logic";
import {
  isResearchKind,
  latestRun,
  latestTitle,
} from "@cashu/ui-logic/investments/v2/research/logic";
import type {
  DigestResearch,
  ResearchRun,
  ResearchSummary,
} from "@cashu/ui-logic/investments/v2/research/types";
import type { Alert, PositionV2, SignalV2, WatchItem } from "@cashu/ui-logic/investments/v2/types";

/** What the old SignalsCtx carried as data (legacy numbers; the callbacks live in the screen hooks). */
export interface SignalsCtx {
  positions: PositionV2[];
  buckets: BucketRow[];
  total: number;
  base: string;
  accounts: AccountRow[];
  today: string;
  contributionDay: number | null;
  alertsById: Map<number, Alert>;
  /** Instrument ids (strings) held anywhere: the Portfel / Obserwowane scope. */
  held: Set<string>;
  watch: WatchItem[];
  /** The last non-failed rules run (finished, else started): the unverified-signal fallback. */
  lastRunAt: string | null;
  /** The research effect line of an instrument for the decision form (`research z soboty: ...`), or null. */
  researchEffect: (instrumentId: number) => string | null;
  /** The identity label's hover card of a title's instrument (old InstLabel inline: accounts, stale price, hints). */
  instCard?: (io: InstOf) => { card: InstCardProps; touchTitle: string };
}

export interface Age {
  text: string;
  warn: boolean;
  title?: string;
}

/** Q18: only the date, `dziś` or `2.10`; an unverified signal shows its last confirmed date in the warn colour. */
export function signalAge(s: SignalV2, ctx: Pick<SignalsCtx, "today" | "lastRunAt">): Age {
  const decided = isDecided(s) ? s.decisions[s.decisions.length - 1] : null;
  if (!decided && !signalCurrent(s, ctx.lastRunAt ?? null) && s.last_seen_at) {
    const d = dm(s.last_seen_at);
    return { text: d, warn: true, title: S.unconfirmedSince(d) };
  }
  const iso = decided?.created_at ?? s.first_seen_at;
  return { text: !iso ? "" : localDay(iso) === ctx.today ? S.today : dm(iso), warn: false };
}

/** The fact line `{pre} <b>{bold}</b>{post}` as its three text parts (a post starting with a comma or a dot
 * joins without a space): old `Fact1`. */
export interface FactParts {
  pre: string;
  bold: string | null;
  post: string;
}
export function factParts(f: SigFact): FactParts {
  return {
    pre: f.pre ? `${f.pre}${f.bold ? " " : ""}` : "",
    bold: f.bold || null,
    post: f.post ? (/^[,.]/.test(f.post) ? f.post : ` ${f.post}`) : "",
  };
}

const namesOf = (ctx: Pick<SignalsCtx, "positions" | "watch">) => {
  const m = new Map(
    ctx.positions.map((p) => [Number(p.instrument.id), instName(p.instrument)] as [number, string]),
  );
  for (const w of ctx.watch)
    if (w.instrument && !m.has(w.instrument_id)) m.set(w.instrument_id, instName(w.instrument));
  return m;
};

/** Origin prefix of a fact's tooltip (rev 2 7.2): `alert: `, `alert agenta: `, `research: `. */
function originOf(s: SignalV2, ctx: Pick<SignalsCtx, "alertsById">): string {
  if (isResearchKind(s.kind) || s.source === "research") return S.originResearch;
  if (s.alert_id != null || s.kind.startsWith("alert:"))
    return ctx.alertsById.get(s.alert_id ?? -1)?.source === "agent"
      ? S.originAgentAlert
      : S.originAlert;
  return "";
}

/** The long form of a signal (the fact's tooltip): origin + `signalText` lead / bold / tail. */
export function longText(
  s: SignalV2,
  ctx: Pick<SignalsCtx, "total" | "base" | "positions" | "watch" | "alertsById">,
): string {
  const t = signalText(s, { total: ctx.total, base: ctx.base, names: namesOf(ctx) });
  return `${originOf(s, ctx)}${[t.lead, t.bold, t.tail].filter(Boolean).join(" ")}`.trim();
}

/** A portfolio subject's title and symbol (no instrument). */
export function plainTitle(
  s: SignalV2,
  ctx: Pick<SignalsCtx, "total" | "base" | "positions" | "watch">,
) {
  const t = signalText(s, { total: ctx.total, base: ctx.base, names: namesOf(ctx) });
  return { title: t.title, sym: t.sym ?? null };
}

export interface InstOf {
  inst: InstLike;
  pos: PositionV2 | null;
  hints: Hint[] | null;
}
/** The instrument of a signal (positions first, then the watchlist) for the identity label. */
export function instOf(
  ctx: Pick<SignalsCtx, "positions" | "watch">,
  id: number | null,
): InstOf | null {
  if (id == null) return null;
  const pos = ctx.positions.find((p) => String(p.instrument.id) === String(id)) ?? null;
  const w = ctx.watch.find((x) => x.instrument_id === Number(id));
  if (pos) return { inst: pos.instrument, pos, hints: pos.hints ?? w?.hints ?? null };
  return w?.instrument ? { inst: w.instrument, pos: null, hints: w.hints ?? null } : null;
}

/** Signals with a decision saved in the last 7 days (footer `decyzje: n z m w tym tygodniu`). */
export const decidedThisWeek = (list: SignalV2[], now: number) => {
  const weekAgo = now - 7 * 86400000;
  return list.filter((s) => s.decisions.some((d) => parseServerTime(d.created_at) >= weekAgo))
    .length;
};

/** `Teza (MM.YYYY)` and the line: entry type · size plan · exit plan, else the thesis text. */
export function thesisLine(t: Thesis): { head: string; text: string } {
  const line = [
    t.entry_type ? (ENTRY_TYPE[t.entry_type] ?? t.entry_type) : null,
    t.size_plan,
    t.exit_plan ? S.exit(t.exit_plan) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const when = t.created_at ? `${t.created_at.slice(5, 7)}.${t.created_at.slice(0, 4)}` : "-";
  return { head: `${S.thesis} (${when})`, text: line || (t.thesis ?? "") };
}

export type Act = "none" | "buy" | "sell" | "later";
export const ACTION: Record<Act, string> = {
  none: "held",
  buy: "bought",
  sell: "sold",
  later: "other",
};
/** The tag of a decision label without its `decyzja: ` / `decision: ` prefix (decisionTag). */
export const tagOf = (label: string) => label.replace(/^(decyzja|decision): /, "");

/** The decision form's default action from the signal's kind. */
export function defaultAct(s: SignalV2 | null | undefined): Act {
  if (!s) return "none";
  const kind = s.kind.startsWith("alert:") ? String(s.payload.alert_kind ?? "") : s.kind;
  switch (kind) {
    case "drawdown_from_high":
    case "loss_from_cost":
    case "price_below":
      return "buy";
    case "gain_from_cost":
    case "position_concentration":
    case "price_above":
      return "sell";
    case "allocation_drift":
      return Number(s.payload.drift_pp) > 0 ? "sell" : "buy";
    default:
      return "none";
  }
}

/** Decision form effect line: `research z soboty: 2 notatki osłabiają tezę (premiera 2028, Q3)`. */
export function researchEffectLine(o: {
  instrumentId: number;
  digest: DigestResearch | null | undefined;
  summary: ResearchSummary | null | undefined;
  runs: ResearchRun[] | null | undefined;
  today: string;
}): string | null {
  const row = o.summary?.instruments.find((s) => s.instrument_id === o.instrumentId);
  const last = latestRun(o.runs ?? []);
  if (!row || !last) return null;
  const changed = o.digest?.theses_changed.find((c) => c.instrument_id === o.instrumentId);
  const c = row.counts;
  const rel = c.invalidates
    ? R.relThesis("invalidates", c.invalidates)
    : c.weakens
      ? R.relThesis("weakens", c.weakens)
      : c.fulfills
        ? R.relThesis("fulfills", c.fulfills)
        : c.supports
          ? R.relThesis("supports", c.supports)
          : null;
  if (!rel && !changed) return null;
  const day = new Date(`${localDay(last.started_at)}T12:00:00`).getDay();
  const weekday = day === 6 ? R.fromSaturday : R.fromDate(dm(last.started_at));
  return R.effect(weekday, rel, latestTitle(row));
}

/** The decisions of a list of signals, newest last (the old row's `decided`). */
export const lastDecision = (s: SignalV2): Decision | null =>
  isDecided(s) ? (s.decisions[s.decisions.length - 1] ?? null) : null;
