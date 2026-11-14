// How a row of the review's decide card reads (designer #21.2, S20): the title is the instrument's name
// (never an id, never the bare ticker while the name is known), a thesis item says what happened to the
// thesis through the catalog, and the rules item reads each stale rule signal through the same sentence
// renderer as the Signals list (`signalText`, incognito-aware). Engine text that stays goes through
// `safeText` (no bucket id, digits masked in incognito).
import type { ReviewDecideItem } from "@cashu/store/investments/review-screen";
import { isShownSignal } from "@cashu/ui-logic/investments/buckets";
import { type SignalTextRow, safeText, signalText } from "../investments/signalText";
import type { DisplayEnv } from "../today/display";
import { S } from "./Review.strings";

/** A signal row as the review reads it (the store's signal row fits it). */
export type DecideSignalRow = SignalTextRow & {
  readonly gid: string;
  readonly instrument: string | null;
  readonly instrumentLabel: string | null;
};

/** What the decide rows are read against. */
export interface DecideTextContext {
  readonly instruments: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly symbol?: string | null;
    readonly currency?: string | null;
  }[];
  /** Every signal row the phone has (the rules item names its rows by gid). */
  readonly signals: readonly DecideSignalRow[];
  readonly baseCurrency: string | null;
  readonly env: DisplayEnv;
}

/** A signal row as a sentence with the instrument's display name. */
function signalSentence(row: DecideSignalRow, ctx: DecideTextContext): string {
  const instrument = ctx.instruments.find((i) => i.id === row.instrument);
  const name = instrument?.name || instrument?.symbol || row.instrumentLabel || "";
  return signalText(
    row,
    { name, currency: instrument?.currency ?? null, baseCurrency: ctx.baseCurrency },
    ctx.env,
  );
}

/** A decide item's title: the instrument's name; the rules item its catalog title; never an id. */
export function decideTitle(item: ReviewDecideItem, ctx: DecideTextContext): string {
  if (item.kind === "rules") return S.rulesTitle;
  if (item.kind === "proposal") return safeText(item.title, ctx.env);
  const name = ctx.instruments.find((i) => i.id === item.instrument)?.name;
  if (name) return name;
  // The store's fallback title is the instrument id when it has no label: never shown as a title.
  if (item.title === "" || item.title === item.instrument) return S.instrumentFallback;
  return safeText(item.title, ctx.env);
}

const THESIS_WHY: Readonly<Record<string, () => string>> = {
  invalidated: () => S.thesisInvalidated,
  weak: () => S.thesisWeakened,
  weakened: () => S.thesisWeakened,
  fulfilled: () => S.thesisFulfilled,
};

/** A decide item's "why" line. */
export function decideWhy(item: ReviewDecideItem, ctx: DecideTextContext): string {
  if (item.kind === "thesis") {
    const to = item.health?.to ?? item.why;
    return (THESIS_WHY[to] ?? (() => S.thesisChanged))();
  }
  if (item.kind === "rules") return "";
  if (item.lead !== undefined && item.whySource !== "research")
    return signalSentence(item.lead, ctx);
  return safeText(item.why, ctx.env);
}

/**
 * The rules item's stale signals as sentences; one the phone has no row for keeps the engine's text made
 * safe, and an allocation drift of the owner's own bucket never shows.
 */
function rulesLines(item: ReviewDecideItem, ctx: DecideTextContext): string[] {
  return item.signals.flatMap((gid, index) => {
    const row = ctx.signals.find((s) => s.gid === gid);
    if (row === undefined) {
      const fact = item.facts[index];
      return fact === undefined ? [] : [safeText(fact, ctx.env)];
    }
    return isShownSignal(row) ? [signalSentence(row, ctx)] : [];
  });
}

/** A decide item's fact lines. */
export function decideFacts(item: ReviewDecideItem, ctx: DecideTextContext): string[] {
  if (item.kind === "rules") return rulesLines(item, ctx);
  if (item.kind === "thesis") return [];
  if (item.supporting !== undefined) return item.supporting.map((row) => signalSentence(row, ctx));
  return item.facts.map((fact) => safeText(fact, ctx.env));
}
