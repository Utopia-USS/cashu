// Whether the weekly (or monthly) investments review is due, without the market: the synced strategy's
// review policy (`review.every`, the weekday), the last review of the module and the device's calendar
// day and zone. The phone's review slot and its weekly reminder read this instead of the full review
// screen, which needs prices and the research inputs. Exported through `@cashu/store/investments/review-screen`.
import { type IsoDate, parseDateTime, utcIso } from "@cashu/domain";
import { strategyStatus, usableConfig } from "@cashu/domain/investments/strategy";
import * as views from "@cashu/domain/investments/views";
import { enabledModuleIds } from "../../core/queries.js";
import { defineQuery, type Read } from "../../query.js";
import { makeReviewClock } from "../views/reviews.js";
import { lastReview } from "./reviews.js";
import { latestStrategyVersion } from "./strategy.js";

export type ReviewDueArgs = {
  /** The device's calendar day. */
  readonly today: IsoDate;
  /** The device's IANA zone: the last review's local day is read in it. */
  readonly timeZone: string;
};

export interface ReviewDue {
  readonly due: boolean;
  /** The first review day after today (the review due today, if any, is `due`). */
  readonly nextOn: IsoDate;
  /** The last review's time (ISO, UTC); null when the module was never reviewed. */
  readonly lastDoneAt: string | null;
  readonly every: ReturnType<typeof views.reviewPolicyView>["every"];
  /** The last review (for its undo and its agenda); null when never reviewed. */
  readonly last: {
    readonly gid: string;
    readonly doneAt: string;
    /** The cards the owner flagged or noted (`stats.session.agenda`); 0 for a review saved elsewhere. */
    readonly agenda: number;
  } | null;
}

function agendaCount(stats: Readonly<Record<string, unknown>>): number {
  const session = stats.session;
  if (typeof session !== "object" || session === null) return 0;
  const agenda = (session as { agenda?: unknown }).agenda;
  return Array.isArray(agenda) ? agenda.length : 0;
}

/** The review schedule of this vault; null without the investments module. */
export function readReviewDue(read: Read, args: ReviewDueArgs): ReviewDue | null {
  if (!enabledModuleIds(read).has("investments")) return null;
  const version = latestStrategyVersion(read);
  // No stored strategy (or an unusable one): the default policy (weekly, on Sunday) applies, as on the Mac.
  const config =
    version === undefined
      ? null
      : usableConfig(
          strategyStatus({ yaml: version.yamlText, md: version.mdText, readError: null }, null),
        );
  const last = lastReview(read, "investments") ?? null;
  // The policy reads the day and the last review's local day only; `now` is the day's start, never used.
  const clock = makeReviewClock({
    now: parseDateTime(`${args.today}T00:00:00Z`),
    today: args.today,
    timeZone: args.timeZone,
  });
  const policy = views.reviewPolicyView(config, clock, last, "en");
  const doneAt = last === null ? null : utcIso(last.doneAt);
  return {
    due: policy.due,
    nextOn: policy.next_on,
    lastDoneAt: doneAt,
    every: policy.every,
    last:
      last === null || doneAt === null
        ? null
        : { gid: last.gid, doneAt, agenda: agendaCount(last.stats) },
  };
}

export const reviewDueQuery = defineQuery({
  id: "investments.review.due",
  run: (read, args: ReviewDueArgs) => readReviewDue(read, args),
});
