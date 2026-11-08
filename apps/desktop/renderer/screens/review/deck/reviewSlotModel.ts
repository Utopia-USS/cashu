// The review's entry in the portfolio hero (ab24ab6 v2/ReviewDeck.tsx ReviewButton + Home.tsx `.rv-slot`, the
// primary button of design V5): the button's text, accessible name and tooltip, the count of items to decide, and
// its popover (the review's breakdown by category, what is in progress but not counted, when it is due), formatted
// here so ReviewSlotView stays pure. The breakdown used to be the rail's review box; the review shows once now.
import { S as R } from "@cashu/i18n/investments/v2/HomeRail.strings";
import { S } from "@cashu/i18n/investments/v2/ReviewDeck.strings";
import { dm } from "@cashu/ui-logic/investments/labels";
import type { DecideGroup, DecideItem } from "@cashu/ui-logic/investments/v2/reviewDeckLogic";

export interface ReviewSlotInput {
  /** `digest.review?.name`; null = the default "Przegląd tygodnia". */
  name: string | null;
  /** The review is due (`digest.review_due` unless it was marked done in this window). */
  due: boolean;
  /** The deck's card count (`data.live.cards.length`): the accessible name keeps it. */
  count: number;
  /** The deck's decide items (`data.live.decide`): the popover's breakdown and the badge. */
  decide: readonly DecideItem[];
  /** When the last review was done (the local one first). */
  last: string | null;
  /** The next scheduled review day. */
  next: string | null;
  onOpen(): void;
  /** "cofnij" next to the button within the server's undo window after a review saved here; else null. */
  onUndo: (() => void) | null;
}

type PopTone = "negative" | "positive" | "neutral" | "info" | "warning";

export interface ReviewSlotModel {
  /** The visible button text: the review's name. */
  name: string;
  label: string;
  title: string;
  due: boolean;
  /** The badge: the number of items to decide while due; null without a badge. */
  badge: number | null;
  /** The popover on hover / focus of the button. */
  pop: {
    title: string;
    rows: { key: string; tone: PopTone; text: string; dim?: boolean }[];
    when: string;
  };
  onOpen(): void;
  onUndo: (() => void) | null;
}

/** Items per category as the old rail box counted them (a "to fix" item counts its signals). */
function breakdown(decide: readonly DecideItem[]) {
  const count = (g: DecideGroup) =>
    decide
      .filter((d) => d.group === g && d.kind !== "proposal")
      .reduce((n, d) => n + (g === "fix" ? (d.signalIds?.length ?? 1) : 1), 0);
  const c = {
    risk: count("risk"),
    chance: count("chance"),
    mixed: count("mixed"),
    proposals: decide.filter((d) => d.kind === "proposal").length,
    fix: count("fix"),
    plan: count("plan"),
  };
  // In progress is shown but not counted: it waits on its own plan, not on a decision.
  return { ...c, toDecide: c.risk + c.chance + c.mixed + c.proposals + c.fix };
}

export function reviewSlotModel({
  name,
  due,
  count,
  decide,
  last,
  next,
  onOpen,
  onUndo,
}: ReviewSlotInput): ReviewSlotModel {
  const title = name ?? S.weeklyReview;
  const done = last ? S.hdrDone(dm(last)) : null;
  const b = breakdown(decide);
  const items = b.toDecide > 0 ? R.reviewItems(b.toDecide) : null;
  const rows: ReviewSlotModel["pop"]["rows"] = [
    { key: "risk", tone: "negative" as const, text: R.pillRisk(b.risk), n: b.risk },
    { key: "chance", tone: "positive" as const, text: R.pillChance(b.chance), n: b.chance },
    { key: "mixed", tone: "neutral" as const, text: R.pillMixed(b.mixed), n: b.mixed },
    { key: "proposal", tone: "info" as const, text: R.pillProposal(b.proposals), n: b.proposals },
    { key: "fix", tone: "warning" as const, text: R.pillFix(b.fix), n: b.fix },
    { key: "plan", tone: "info" as const, text: R.planNotCounted(b.plan), n: b.plan, dim: true },
  ]
    .filter((r) => r.n > 0)
    .map(({ n: _n, ...r }) => r);
  return {
    name: title,
    label: due
      ? `${title} · ${items ? `${items} · ` : ""}${S.hdrCards(count)}`
      : `${title} · ${done ?? S.hdrOpen}`,
    title: due
      ? `${title}: ${S.hdrCardsToReview(count)}`
      : `${title}${done ? ` · ${done}` : ""}${next ? ` · ${S.hdrNext(dm(next))}` : ""}`,
    due,
    badge: due && b.toDecide > 0 ? b.toDecide : null,
    pop: {
      title: items ?? S.popNothing,
      rows,
      when: [due ? S.popDue : next ? S.popNext(dm(next)) : null, last ? S.popLast(dm(last)) : null]
        .filter(Boolean)
        .join(" · "),
    },
    onOpen,
    onUndo,
  };
}
