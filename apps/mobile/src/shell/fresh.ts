// The freshness line of a tab header (prototype `freshLine`): when the newest bank import finished, as
// a time today, a weekday and time within the week, else a date; a warning once it is older than the
// attention list's stale threshold.
import { daysBetween } from "@cashu/domain";
import { ATTENTION_THRESHOLDS } from "@cashu/domain/core/attention";
import { formatCalendarDate, formatClockTime } from "@cashu/i18n/values";
import { localToday } from "../screens/screenContext";
import { S } from "./Shell.strings";
import type { TabFresh } from "./TabHeader";

const HOUR_MS = 3_600_000;
/** Within this many calendar days the line names the weekday ("from Mon 07:30"), beyond it the date. */
const WEEKDAY_DAYS = 6;

/** When the bank data is from, in the device timezone: "06:40", "Mon 07:30" or "3 Nov 2026". */
function whenLabel(at: Date, now: Date, locale: string): string {
  const day = localToday(at);
  const days = daysBetween(day, localToday(now));
  if (days === 0) return formatClockTime(at, locale);
  if (days > 0 && days <= WEEKDAY_DAYS) return formatClockTime(at, locale, { weekday: true });
  return formatCalendarDate(day, locale);
}

/** The prices line of the vault's `pricesFetchedAt` (when this phone last fetched its prices itself,
 * an ISO instant), muted before the first fetch. */
export function pricesFresh(fetchedAt: string | null, now: Date, locale: string): TabFresh {
  if (fetchedAt === null) return { tone: "muted", text: S.pricesNotYet };
  return { tone: "ok", text: S.pricesFrom(whenLabel(new Date(fetchedAt), now, locale)) };
}

/** The bank line of `dataFreshness().bankDataAt` (an ISO instant, or null before the first import). */
export function bankFresh(bankDataAt: string | null, now: Date, locale: string): TabFresh {
  if (bankDataAt === null) return { tone: "muted", text: S.noBankData };
  const at = new Date(bankDataAt);
  const label = whenLabel(at, now, locale);
  const hours = (now.getTime() - at.getTime()) / HOUR_MS;
  return hours >= ATTENTION_THRESHOLDS.staleAfterHours
    ? { tone: "warn", text: S.bankDataOld(label, hours) }
    : { tone: "ok", text: S.bankDataFrom(label) };
}
