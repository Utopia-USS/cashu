// Every notification message as the OS shows it, in both languages: the title with and without the
// profile, each body with its optional sentences, month names from `Intl`. The "since" of the stale
// warning is built in the device timezone, as the phone shows it. Synthetic data only.
import { setLanguageForTests } from "@cashu/i18n";
import { renderNotification } from "./render";

/** Thursday 12 November 2026, 09:15 on this device. */
const NOW = new Date(2026, 10, 12, 9, 15);

const en = (message: Parameters<typeof renderNotification>[0], profile: string | null = null) =>
  renderNotification(message, profile, "en", "en-US", NOW);
const pl = (message: Parameters<typeof renderNotification>[0], profile: string | null = null) =>
  renderNotification(message, profile, "pl", "pl-PL", NOW);

afterEach(() => setLanguageForTests("en"));

describe("renderNotification: title", () => {
  it("names the profile only when the phone holds more than one", () => {
    const message = { kind: "consent_ending", days: 7 } as const;
    expect(en(message).title).toBe("cashU");
    expect(en(message, "Anna").title).toBe("cashU · Anna");
    expect(pl(message).title).toBe("cashU");
    expect(pl(message, "Dom").title).toBe("cashU · Dom");
  });

  it("leaves the UI language as it was", () => {
    setLanguageForTests("pl");
    expect(en({ kind: "alerts_fired", count: 1 }).body).toBe(
      "An alert you follow fired. Open cashU to see it.",
    );
    expect(pl({ kind: "consent_ending", days: 1 }).body).toBe("Zgoda banku wygasa jutro.");
    setLanguageForTests("en");
    expect(pl({ kind: "consent_ending", days: 1 }).body).toBe("Zgoda banku wygasa jutro.");
  });
});

describe("renderNotification: alerts_fired", () => {
  it("says one alert or how many", () => {
    expect(en({ kind: "alerts_fired", count: 1 }).body).toBe(
      "An alert you follow fired. Open cashU to see it.",
    );
    expect(en({ kind: "alerts_fired", count: 3 }).body).toBe(
      "3 alerts you follow fired. Open cashU to see them.",
    );
    expect(pl({ kind: "alerts_fired", count: 1 }).body).toBe(
      "Zadziałał alert, który obserwujesz. Otwórz cashU, żeby go zobaczyć.",
    );
    expect(pl({ kind: "alerts_fired", count: 3 }).body).toBe(
      "Zadziałały 3 alerty, które obserwujesz. Otwórz cashU, żeby je zobaczyć.",
    );
    expect(pl({ kind: "alerts_fired", count: 5 }).body).toBe(
      "Zadziałało 5 alertów, które obserwujesz. Otwórz cashU, żeby je zobaczyć.",
    );
  });
});

describe("renderNotification: device_change", () => {
  it("says what joined, what left, or both", () => {
    expect(en({ kind: "device_change", joined: 1, left: 0 }).body).toBe(
      "A device joined this profile.",
    );
    expect(en({ kind: "device_change", joined: 0, left: 1 }).body).toBe(
      "A device left this profile.",
    );
    expect(en({ kind: "device_change", joined: 2, left: 1 }).body).toBe(
      "2 devices joined this profile. A device left this profile.",
    );
    expect(pl({ kind: "device_change", joined: 1, left: 0 }).body).toBe(
      "Urządzenie dołączyło do tego profilu.",
    );
    expect(pl({ kind: "device_change", joined: 0, left: 1 }).body).toBe(
      "Urządzenie odłączyło się od tego profilu.",
    );
    expect(pl({ kind: "device_change", joined: 2, left: 5 }).body).toBe(
      "2 urządzenia dołączyły do tego profilu. 5 urządzeń odłączyło się od tego profilu.",
    );
  });
});

describe("renderNotification: evening", () => {
  it("counts tomorrow's bills and the payments to categorize, leaving out a zero", () => {
    expect(en({ kind: "evening", billsTomorrow: 1, toCategorize: 4 }).body).toBe(
      "1 bill due tomorrow. 4 payments to categorize.",
    );
    expect(en({ kind: "evening", billsTomorrow: 0, toCategorize: 1 }).body).toBe(
      "1 payment to categorize.",
    );
    expect(en({ kind: "evening", billsTomorrow: 2, toCategorize: 0 }).body).toBe(
      "2 bills due tomorrow.",
    );
    expect(pl({ kind: "evening", billsTomorrow: 1, toCategorize: 4 }).body).toBe(
      "Jutro do zapłaty: 1 rachunek. 4 płatności bez kategorii.",
    );
    expect(pl({ kind: "evening", billsTomorrow: 5, toCategorize: 1 }).body).toBe(
      "Jutro do zapłaty: 5 rachunków. 1 płatność bez kategorii.",
    );
  });
});

describe("renderNotification: weekly", () => {
  it("is the week in one line, with review and the Mac only when there is something", () => {
    expect(en({ kind: "weekly", billsNextWeek: 3, reviewDue: false, waitingOnMac: 0 }).body).toBe(
      "Your week is ready. 3 bills next week.",
    );
    expect(en({ kind: "weekly", billsNextWeek: 3, reviewDue: true, waitingOnMac: 2 }).body).toBe(
      "Your week is ready. 3 bills next week. Review due. 2 things wait for you on your Mac.",
    );
    expect(en({ kind: "weekly", billsNextWeek: 0, reviewDue: false, waitingOnMac: 1 }).body).toBe(
      "Your week is ready. No bills next week. 1 thing waits for you on your Mac.",
    );
    expect(pl({ kind: "weekly", billsNextWeek: 3, reviewDue: true, waitingOnMac: 2 }).body).toBe(
      "Podsumowanie tygodnia jest gotowe. W przyszłym tygodniu do zapłaty: 3 rachunki. Pora na przegląd. Na Macu czekają na Ciebie 2 sprawy.",
    );
    expect(pl({ kind: "weekly", billsNextWeek: 0, reviewDue: false, waitingOnMac: 5 }).body).toBe(
      "Podsumowanie tygodnia jest gotowe. W przyszłym tygodniu nic do zapłaty. Na Macu czeka na Ciebie 5 spraw.",
    );
  });
});

describe("renderNotification: month_closed", () => {
  it("names the month and mentions the plan only with one", () => {
    expect(en({ kind: "month_closed", month: "2026-10", hasPlan: false }).body).toBe(
      "October closed. Open cashU to see what you kept.",
    );
    expect(en({ kind: "month_closed", month: "2026-10", hasPlan: true }).body).toBe(
      "October closed. Open cashU to see what you kept and what your plan says.",
    );
    expect(pl({ kind: "month_closed", month: "2026-10", hasPlan: false }).body).toBe(
      "Październik zamknięty. Otwórz cashU i zobacz, ile Ci zostało.",
    );
    expect(pl({ kind: "month_closed", month: "2026-10", hasPlan: true }).body).toBe(
      "Październik zamknięty. Otwórz cashU i zobacz, ile Ci zostało i co na to Twój plan.",
    );
  });
});

describe("renderNotification: stale_data", () => {
  it("says since yesterday, since a weekday within the week, else since a date", () => {
    // 30 hours before Thursday 09:15 is Wednesday 03:15.
    expect(en({ kind: "stale_data", ageHours: 30 }).body).toBe(
      "Bank data has not been updated since yesterday.",
    );
    // 40 hours before is Tuesday 17:15.
    expect(en({ kind: "stale_data", ageHours: 40 }).body).toBe(
      "Bank data has not been updated since Tuesday.",
    );
    // 200 hours before is Wednesday 4 November.
    expect(en({ kind: "stale_data", ageHours: 200 }).body).toBe(
      "Bank data has not been updated since November 4.",
    );
    expect(pl({ kind: "stale_data", ageHours: 30 }).body).toBe(
      "Brak nowych danych z banku od wczoraj.",
    );
    expect(pl({ kind: "stale_data", ageHours: 40 }).body).toBe(
      "Brak nowych danych z banku od wtorku.",
    );
    expect(pl({ kind: "stale_data", ageHours: 72 }).body).toBe(
      "Brak nowych danych z banku od poniedziałku.",
    );
    expect(pl({ kind: "stale_data", ageHours: 200 }).body).toBe(
      "Brak nowych danych z banku od 4 listopada.",
    );
  });
});

describe("renderNotification: consent_ending", () => {
  it("counts the days, then says tomorrow and today", () => {
    expect(en({ kind: "consent_ending", days: 7 }).body).toBe("A bank permission ends in 7 days.");
    expect(en({ kind: "consent_ending", days: 1 }).body).toBe("A bank permission ends tomorrow.");
    expect(en({ kind: "consent_ending", days: 0 }).body).toBe("A bank permission ends today.");
    expect(pl({ kind: "consent_ending", days: 7 }).body).toBe("Zgoda banku wygasa za 7 dni.");
    expect(pl({ kind: "consent_ending", days: 2 }).body).toBe("Zgoda banku wygasa za 2 dni.");
    expect(pl({ kind: "consent_ending", days: 1 }).body).toBe("Zgoda banku wygasa jutro.");
    expect(pl({ kind: "consent_ending", days: 0 }).body).toBe("Zgoda banku wygasa dziś.");
  });
});
