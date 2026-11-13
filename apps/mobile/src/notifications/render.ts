// A planned notification's message as the title and body the OS shows, written on this phone from its
// own catalog: the message carries counts only, so the text can never hold an amount, a payee or a name.
import { daysBetween } from "@cashu/domain";
import type { NotificationMessage } from "@cashu/domain/core/notifications";
import { inEveryLang, LANGS, type Lang } from "@cashu/i18n";
import { dayMonth, localToday, monthName } from "../format/calendar";
import { S, type Since } from "./Notifications.strings";

export interface RenderedNotification {
  readonly title: string;
  readonly body: string;
}

const HOUR_MS = 3_600_000;
/** Within this many calendar days the stale warning names the weekday, beyond it the date. */
const WEEKDAY_DAYS = 6;

/** When bank data `ageHours` old at `now` was last updated, in the device timezone. */
function since(ageHours: number, now: Date, locale: string): Since {
  const at = new Date(now.getTime() - ageHours * HOUR_MS);
  const day = localToday(at);
  const days = daysBetween(day, localToday(now));
  if (days <= 1) return { kind: "yesterday" };
  if (days <= WEEKDAY_DAYS) return { kind: "weekday", day: at.getDay() };
  return { kind: "date", label: dayMonth(day, locale) };
}

function body(message: NotificationMessage, locale: string, now: Date): string {
  switch (message.kind) {
    case "alerts_fired":
      return S.alertsFired(message.count);
    case "device_change":
      return [
        message.joined > 0 ? S.deviceJoined(message.joined) : null,
        message.left > 0 ? S.deviceLeft(message.left) : null,
      ]
        .filter((s) => s !== null)
        .join(" ");
    case "evening":
      return [
        message.billsTomorrow > 0 ? S.billsTomorrow(message.billsTomorrow) : null,
        message.toCategorize > 0 ? S.toCategorize(message.toCategorize) : null,
      ]
        .filter((s) => s !== null)
        .join(" ");
    case "weekly":
      return [
        S.weekReady,
        message.billsNextWeek > 0 ? S.billsNextWeek(message.billsNextWeek) : S.noBillsNextWeek,
        message.reviewDue ? S.reviewDue : null,
        message.waitingOnMac > 0 ? S.waitingOnMac(message.waitingOnMac) : null,
      ]
        .filter((s) => s !== null)
        .join(" ");
    case "month_closed":
      return S.monthClosed(monthName(message.month, locale), message.hasPlan);
    case "stale_data":
      return S.staleData(since(message.ageHours, now, locale));
    case "consent_ending":
      return S.consentEnding(message.days);
  }
}

/**
 * The title ("cashU", or "cashU · Anna" when the phone holds 2+ profiles) and body of one message in
 * `lang`, with `locale`'s month and date names; `now` places the stale warning's "since" in the device
 * timezone. Works outside React (the background planner) and leaves the UI language as it was.
 */
export function renderNotification(
  message: NotificationMessage,
  profileLabel: string | null,
  lang: Lang,
  locale: string,
  now: Date,
): RenderedNotification {
  const all = inEveryLang(() => ({
    title: S.title(profileLabel),
    body: body(message, locale, now),
  }));
  const rendered = all[LANGS.indexOf(lang)];
  if (rendered === undefined) throw new RangeError(`unsupported language ${lang}`);
  return rendered;
}
