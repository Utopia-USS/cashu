// The text of the phone's notifications (design/mobile/companion section 6): counts only, never an
// amount, a payee or a name. PL + EN. A body is built from these sentences by `renderNotification`.
// A month arrives as `MonthName` (from `Intl`), the last bank fetch as `Since`.
import { catalog, enCount, enForm, plCount, plForm } from "@cashu/i18n";
import type { MonthName } from "../format/calendar";

/** When the bank data was last updated: yesterday, a weekday within the week (0 = Sunday) or a date. */
export type Since =
  | { readonly kind: "yesterday" }
  | { readonly kind: "weekday"; readonly day: number }
  | { readonly kind: "date"; readonly label: string };

const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Genitive ("od wtorku"). */
const PL_WEEKDAYS_OF = [
  "niedzieli",
  "poniedziałku",
  "wtorku",
  "środy",
  "czwartku",
  "piątku",
  "soboty",
];

const enSince = (since: Since) =>
  since.kind === "yesterday"
    ? "yesterday"
    : since.kind === "weekday"
      ? (EN_WEEKDAYS[since.day] ?? "")
      : since.label;
const plSince = (since: Since) =>
  since.kind === "yesterday"
    ? "wczoraj"
    : since.kind === "weekday"
      ? (PL_WEEKDAYS_OF[since.day] ?? "")
      : since.label;

export const S = catalog({
  /** The title: the app, and the profile when the phone holds more than one. */
  title: {
    pl: (profile: string | null) => (profile === null ? "cashU" : `cashU · ${profile}`),
    en: (profile: string | null) => (profile === null ? "cashU" : `cashU · ${profile}`),
  },
  alertsFired: {
    pl: (n: number) =>
      plForm(
        n,
        "Zadziałał alert, który obserwujesz. Otwórz cashU, żeby go zobaczyć.",
        `Zadziałały ${n} alerty, które obserwujesz. Otwórz cashU, żeby je zobaczyć.`,
        `Zadziałało ${n} alertów, które obserwujesz. Otwórz cashU, żeby je zobaczyć.`,
      ),
    en: (n: number) =>
      enForm(
        n,
        "An alert you follow fired. Open cashU to see it.",
        `${n} alerts you follow fired. Open cashU to see them.`,
      ),
  },
  deviceJoined: {
    pl: (n: number) =>
      plForm(
        n,
        "Urządzenie dołączyło do tego profilu.",
        `${n} urządzenia dołączyły do tego profilu.`,
        `${n} urządzeń dołączyło do tego profilu.`,
      ),
    en: (n: number) =>
      enForm(n, "A device joined this profile.", `${n} devices joined this profile.`),
  },
  deviceLeft: {
    pl: (n: number) =>
      plForm(
        n,
        "Urządzenie odłączyło się od tego profilu.",
        `${n} urządzenia odłączyły się od tego profilu.`,
        `${n} urządzeń odłączyło się od tego profilu.`,
      ),
    en: (n: number) => enForm(n, "A device left this profile.", `${n} devices left this profile.`),
  },
  billsTomorrow: {
    pl: (n: number) => `Jutro do zapłaty: ${plCount(n, "rachunek", "rachunki", "rachunków")}.`,
    en: (n: number) => `${enCount(n, "bill", "bills")} due tomorrow.`,
  },
  toCategorize: {
    pl: (n: number) => `${plCount(n, "płatność", "płatności", "płatności")} bez kategorii.`,
    en: (n: number) => `${enCount(n, "payment", "payments")} to categorize.`,
  },
  weekReady: { pl: "Podsumowanie tygodnia jest gotowe.", en: "Your week is ready." },
  billsNextWeek: {
    pl: (n: number) =>
      `W przyszłym tygodniu do zapłaty: ${plCount(n, "rachunek", "rachunki", "rachunków")}.`,
    en: (n: number) => `${enCount(n, "bill", "bills")} next week.`,
  },
  noBillsNextWeek: {
    pl: "W przyszłym tygodniu nic do zapłaty.",
    en: "No bills next week.",
  },
  reviewDue: { pl: "Pora na przegląd.", en: "Review due." },
  waitingOnMac: {
    pl: (n: number) =>
      `Na Macu ${plForm(n, "czeka", "czekają", "czeka")} na Ciebie ${plCount(n, "sprawa", "sprawy", "spraw")}.`,
    en: (n: number) =>
      `${enCount(n, "thing", "things")} ${enForm(n, "waits", "wait")} for you on your Mac.`,
  },
  monthClosed: {
    pl: (m: MonthName, hasPlan: boolean) =>
      `${m.title} zamknięty. Otwórz cashU i zobacz, ile Ci zostało${hasPlan ? " i co na to Twój plan" : ""}.`,
    en: (m: MonthName, hasPlan: boolean) =>
      `${m.title} closed. Open cashU to see what you kept${hasPlan ? " and what your plan says" : ""}.`,
  },
  staleData: {
    pl: (since: Since) => `Brak nowych danych z banku od ${plSince(since)}.`,
    en: (since: Since) => `Bank data has not been updated since ${enSince(since)}.`,
  },
  consentEnding: {
    pl: (days: number) =>
      days <= 0
        ? "Zgoda banku wygasa dziś."
        : days === 1
          ? "Zgoda banku wygasa jutro."
          : `Zgoda banku wygasa za ${plCount(days, "dzień", "dni", "dni")}.`,
    en: (days: number) =>
      days <= 0
        ? "A bank permission ends today."
        : days === 1
          ? "A bank permission ends tomorrow."
          : `A bank permission ends in ${enCount(days, "day", "days")}.`,
  },
});
