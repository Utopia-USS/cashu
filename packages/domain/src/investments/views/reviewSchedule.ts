/** Review dates reuse the existing strategy schedule; timezone conversion is caller-injected. */

import type { UiLang } from "../../core/i18n.js";
import { addDays, type DateTime, type IsoDate } from "../../dates.js";
import {
  DEFAULT_NOTIFICATIONS,
  DEFAULT_REVIEW,
  isoNumber,
  reviewSchedule,
  reviewTitle,
  type StrategyConfig,
} from "../strategy/index.js";

export { reviewSchedule } from "../strategy/index.js";

export interface ReviewClock {
  readonly now: DateTime;
  readonly today: IsoDate;
  readonly localDate: (at: DateTime | string) => IsoDate;
  readonly midnight: (day: IsoDate) => DateTime;
}

export interface LastReviewFact {
  readonly doneAt: string;
  readonly notes: string | null;
  readonly stats: Readonly<Record<string, unknown>>;
}

export function reviewPolicyView(
  config: StrategyConfig | null,
  clock: ReviewClock,
  last: LastReviewFact | null,
  lang: UiLang,
) {
  const policy = config?.review ?? DEFAULT_REVIEW;
  const weekday =
    policy.day ?? config?.notifications.digestWeekday ?? DEFAULT_NOTIFICATIONS.digestWeekday;
  const [due, next] = reviewSchedule(
    policy.every,
    isoNumber(weekday),
    clock.today,
    last === null ? null : clock.localDate(last.doneAt),
  );
  return {
    name: reviewTitle(policy, lang),
    every: policy.every,
    day: weekday,
    cards: [...policy.cards],
    due,
    next_on: next,
  };
}

export function reviewSinceDay(clock: ReviewClock, last: LastReviewFact | null): IsoDate {
  return last === null ? addDays(clock.today, -7) : clock.localDate(last.doneAt);
}
