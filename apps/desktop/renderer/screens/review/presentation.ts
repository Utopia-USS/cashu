import type { ReadyReview, ReviewDecideItem } from "@cashu/store/investments/review-screen";
import { label } from "@cashu/ui-logic/core/messages";
import { localDay } from "@cashu/ui-logic/core/time";
import { ENTRY_TYPE } from "@cashu/ui-logic/investments/labels";
import {
  candidateCriteria,
  criterionText,
  HEALTH_LABEL,
  normHealth,
  noteSubject,
  safeUrl,
  summaryWithoutCriteria,
} from "@cashu/ui-logic/investments/v2/research/logic";
import { R } from "./Review.strings.js";
export function reviewSourceMessage(
  status: { readonly status: string; readonly reason?: string },
  source: string,
): string | null {
  return status.status === "current"
    ? null
    : status.status === "error"
      ? R.sourceError(source)
      : status.reason?.includes("unbound")
        ? R.sourceUnbound(source)
        : R.sourceMissing(source);
}
export const reviewDisplayDay = (timestamp: string | null) =>
  timestamp === null ? null : localDay(timestamp);
export function reviewDisplayDates(snapshot: ReadyReview | null) {
  return {
    notes: Object.fromEntries(
      [...(snapshot?.events.map((event) => event.note) ?? []), ...(snapshot?.ideas ?? [])].map(
        (note) => [note.id, reviewDisplayDay(note.observed_at)],
      ),
    ),
    calendarFetched:
      snapshot?.calendar.status === "current"
        ? reviewDisplayDay(snapshot.calendar.value.fetched_at)
        : null,
    ladders: Object.fromEntries(
      snapshot?.decide.items.map((item) => [
        item.key,
        reviewDisplayDay(item.ladder?.since ?? null),
      ]) ?? [],
    ),
    macroChanges: Object.fromEntries(
      snapshot?.macroChanges.map((row) => [row.key, reviewDisplayDay(row.since)]) ?? [],
    ),
  };
}
export const reviewRiskMacro = (snapshot: ReadyReview | null) =>
  snapshot?.macro.status === "current"
    ? (snapshot.macro.value.find((row) => row.key === "risk") ?? null)
    : null;
const text = (value: unknown) => (typeof value === "string" ? value : null);
export function presentReviewIdea(note: ReadyReview["ideas"][number]) {
  const subject = noteSubject({
    instrument: note.instrument,
    candidate:
      note.candidate === null
        ? null
        : {
            name: text(note.candidate.name),
            symbol: text(note.candidate.symbol),
            exchange: text(note.candidate.exchange),
          },
    theme: note.theme,
    title: note.title,
    segment: note.segment,
    segment_label: note.segment_label,
  });
  const criteria = candidateCriteria(note);
  const entry = text(note.details?.entry_type);
  return {
    ...note,
    subject,
    context: text(note.details?.context) ?? summaryWithoutCriteria(note.summary),
    entryType: entry === null ? null : (ENTRY_TYPE[entry] ?? null),
    criteria: {
      ...criteria,
      items: criteria.items.map((row) => ({ ...row, label: criterionText(row) })),
    },
    sourceLinks: note.sources.flatMap((source) => {
      const url = safeUrl(text(source.url));
      return url === null
        ? []
        : [{ url, label: text(source.title) ?? text(source.publisher) ?? url }];
    }),
  };
}
const clean = (value: string | null) =>
  value
    ?.replace(/\[(do potwierdzenia|to confirm)\]\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim() || null;
const sentence = (value: string) => {
  const first = (value.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? value).trim();
  return first.length > 180 ? `${first.slice(0, 180).replace(/\s+\S*$/, "")}…` : first;
};
/** Reuse neutral Signals message codes; note prose remains exactly as authored. */
export function presentReviewItem(item: ReviewDecideItem) {
  const prose = (row: NonNullable<ReviewDecideItem["lead"]>) =>
    label(row.messageCode, row.messageParams) ?? row.message;
  const health = item.kind === "thesis" ? normHealth(item.health?.to ?? item.why) : null;
  const previousHealth = item.kind === "thesis" ? normHealth(item.health?.from ?? null) : null;
  const title =
    item.kind === "thesis" && health
      ? R.thesisChanged(item.title, HEALTH_LABEL[health])
      : item.title || (item.lead ? prose(item.lead) : R.fix);
  const why =
    item.kind === "thesis"
      ? `${previousHealth ? R.was(HEALTH_LABEL[previousHealth]) : ""}${health === "ful" ? R.fulfilledWhy : R.againstWhy}`
      : item.whySource === "health"
        ? item.relation === "fulfills"
          ? R.fulfilledWhy
          : R.againstWhy
        : item.whySource === "research"
          ? item.why
          : item.lead
            ? prose(item.lead)
            : item.why;
  const facts = item.supporting?.map(prose) ?? item.facts;
  const exit = clean(item.exitPlan),
    invalidation = clean(item.invalidation);
  const context =
    item.group === "plan" && exit
      ? R.yourPlan(sentence(exit))
      : item.relation === "fulfills"
        ? exit
          ? R.yourPlan(sentence(exit))
          : R.noExit
        : item.group === "risk" && invalidation && invalidation !== "-"
          ? R.failsWhen(sentence(invalidation))
          : null;
  return {
    ...item,
    title,
    why,
    facts,
    factRows: facts.map((text, index) => ({
      id: item.supporting?.[index]?.gid ?? item.signals[index] ?? text,
      text,
    })),
    context,
    actions: reviewActions(item),
  };
}
export type ReviewChoice = "held" | "bought" | "sold" | "ack" | "snooze" | "review" | "keep";
export function reviewSkipReason(reason: string): string {
  return reason === "no_sectors"
    ? R.no_sectors
    : reason === "no_positions"
      ? R.no_positions
      : reason === "no_events"
        ? R.no_events
        : reason === "no_ideas"
          ? R.no_ideas
          : reason === "no_decide"
            ? R.no_decide
            : R.source_unavailable;
}
export function reviewChoiceLabel(action: string): string {
  return action === "held"
    ? R.held
    : action === "bought"
      ? R.bought
      : action === "sold"
        ? R.sold
        : action === "snooze"
          ? R.snooze
          : action === "review"
            ? R.reviewThesis
            : action === "keep"
              ? R.held
              : R.acknowledge;
}
function reviewActions(
  item: ReviewDecideItem,
): readonly { readonly action: ReviewChoice; readonly label: string }[] {
  if (item.kind === "thesis")
    return [
      { action: "review", label: R.reviewThesis },
      { action: "keep", label: R.held },
    ];
  if (item.kind === "proposal") return [{ action: "ack", label: R.proposal }];
  const choices: ReviewChoice[] =
    item.instrument === null || item.group === "mixed" || item.group === "fix"
      ? ["ack", "snooze"]
      : item.group === "risk" || item.group === "plan"
        ? ["sold", "held", "snooze"]
        : ["bought", "held", "snooze"];
  return choices.map((action) => ({
    action,
    label:
      item.group === "plan" && action === "sold"
        ? R.planDone
        : item.group === "plan" && action === "held"
          ? R.planStands
          : reviewChoiceLabel(action),
  }));
}
