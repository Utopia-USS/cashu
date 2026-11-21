// Notifications are counts only, checked where they leave the app: every title, body and data value the
// planner hands the OS scheduler, in Polish and in English, over real synthetic stores with every choice
// on. None may carry an account name, a merchant, an IBAN, an instrument name or symbol, or any amount of
// the fixture in any formatting. The forbidden strings are written out here from the fixture's inputs,
// not read back from the code under test. Synthetic data.
import { setAlertMarked, setNotificationPrefs } from "@cashu/store/device";
import type { Read } from "@cashu/store/query";
import { companionMarkedAlert } from "../fixture/companionInvestments";
import { investmentsStore } from "../screens/testing/investmentsStore";
import {
  importMoneyFacts,
  MONEY_OWN_A,
  MONEY_OWN_B,
  MONEY_VAULT_A,
  MONEY_VAULT_B,
  moneyStore,
} from "../screens/testing/moneyStore";
import { type PlanContext, planNotifications } from "./planner";
import type { ScheduledNotification } from "./scheduler";
import { memoryScheduler } from "./testing/memoryScheduler";

const LANGS = [
  { lang: "pl", locale: "pl-PL" },
  { lang: "en", locale: "en-US" },
] as const;

const EVERY_CHOICE = {
  evening: true,
  weekly: true,
  monthClosed: true,
  staleData: true,
  consentEnding: true,
  alertsFired: true,
} as const;

/** Thursday 5 November 2026, 09:00 in Warsaw; the bank data is from early November. */
const NOW = new Date("2026-11-05T08:00:00Z");
const TODAY = "2026-11-05";

// The money fixture's own words: `importMoneyFacts` names every account and counterparty so.
const MONEY_WORDS = ["Synthetic account", "Synthetic counterparty", MONEY_OWN_A, MONEY_OWN_B];
const MERCHANTS = {
  a: ["Sklep Kwiatowy Lipa", "Kawiarnia Pod Zegarem"],
  b: ["Apteka Pod Orlem", "Stacja Paliw Brzoza"],
} as const;
// Distinctive amounts (and their monthly sums per vault): none is a count a notification could show.
const AMOUNTS = {
  a: ["-4217.53", "-1386.29"],
  b: ["-5729.41", "-2648.17"],
} as const;
const AMOUNT_DIGITS = ["421753", "4217", "138629", "1386", "572941", "5729", "264817", "2648"];

// The investments fixture's instruments, symbols and accounts (`fixture/companionInvestments.ts`).
const INVESTMENT_WORDS = [
  "CD Projekt",
  "CDR",
  "Vanguard FTSE All-World",
  "Obligacje skarbowe EDO",
  "Polish Bond ETF",
  "Vanguard Total World",
  "Beta ETF S&P 500",
  "Beta ETF mWIG40TR",
  "ETFBM40TR",
  "Brokerage",
];

function context(
  services: PlanContext["services"],
  scheduler: PlanContext["scheduler"],
  now: Date,
  today: string,
  lang: "pl" | "en",
  locale: string,
): PlanContext {
  return { services, scheduler, now, today, timeZone: "Europe/Warsaw", lang, locale };
}

/** Everything the OS receives of one notification, as text. */
function surfaces(n: ScheduledNotification): string[] {
  return [n.title, n.body, ...Object.keys(n.data), ...Object.values(n.data)];
}

/** Digit runs with their grouping and decimal separators removed: `4 217,53` and `4,217.53` read `421753`. */
function digitRuns(text: string): string {
  return text.replace(/(\d)[\s  .,'](?=\d)/gu, "$1");
}

function expectCountsOnly(sent: readonly ScheduledNotification[], words: readonly string[]): void {
  for (const n of sent) {
    expect(Object.keys(n.data).every((key) => ["vault", "kind", "month"].includes(key))).toBe(true);
    for (const text of surfaces(n)) {
      for (const word of words) expect(text.toLowerCase()).not.toContain(word.toLowerCase());
      const runs = digitRuns(text);
      for (const digits of AMOUNT_DIGITS) expect(runs).not.toContain(digits);
      // No currency either: a count never has one.
      // (`zł` only as a word: "przyszłym" holds the letters.)
      expect(text).not.toMatch(/(?<!\p{L})zł|PLN|EUR|USD|€|\$/u);
    }
  }
}

function sentBy(scheduler: ReturnType<typeof memoryScheduler>): ScheduledNotification[] {
  return [...scheduler.delivered, ...scheduler.pending.values()];
}

describe.each(LANGS)("counts only ($lang)", ({ lang, locale }) => {
  it("the money fixture: evening, weekly, month closed and stale data name no account, merchant or amount", async () => {
    const fixture = moneyStore();
    for (const [handle, account, key] of [
      [fixture.a, MONEY_OWN_A, "a"],
      [fixture.b, MONEY_OWN_B, "b"],
    ] as const) {
      importMoneyFacts(handle, "PLN", account, [
        { date: "2026-10-28", amount: AMOUNTS[key][0], key: MERCHANTS[key][0] },
        { date: "2026-11-03", amount: AMOUNTS[key][1], key: MERCHANTS[key][1] },
      ]);
    }
    for (const vault of [MONEY_VAULT_A, MONEY_VAULT_B])
      fixture.services.device.run(setNotificationPrefs, { vault, prefs: EVERY_CHOICE });
    const scheduler = memoryScheduler("granted");
    await planNotifications(context(fixture.services, scheduler, NOW, TODAY, lang, locale));
    // Two days later the bank data is old: the owner is warned.
    const later = new Date("2026-11-08T08:00:00Z");
    await planNotifications(
      context(fixture.services, scheduler, later, "2026-11-08", lang, locale),
    );

    const sent = sentBy(scheduler);
    // The oracle covers what it claims: every kind the planner can send over a budget-only household.
    expect(new Set(sent.map((n) => n.data.kind))).toEqual(
      new Set(["evening", "weekly", "month_closed", "stale_data"]),
    );
    expectCountsOnly(sent, [...MONEY_WORDS, ...MERCHANTS.a, ...MERCHANTS.b]);
    fixture.close();
  });

  it("the investments fixture: a marked alert names no instrument, symbol, account or amount", async () => {
    const fixture = investmentsStore();
    const now = new Date(fixture.now);
    const read: Read = (sql, ...params) => fixture.store.read(sql, ...params);
    const alert = companionMarkedAlert(read, fixture.now);
    if (alert === null) throw new Error("the synthetic portfolio fired no action alert");
    const vault = fixture.services.profiles[0]?.vault ?? "";
    fixture.services.device.run(setAlertMarked, { vault, alert, marked: true });
    fixture.services.device.run(setNotificationPrefs, { vault, prefs: EVERY_CHOICE });
    const scheduler = memoryScheduler("granted");
    await planNotifications(context(fixture.services, scheduler, now, fixture.today, lang, locale));

    const sent = sentBy(scheduler);
    expect(sent.map((n) => n.data.kind)).toContain("alerts_fired");
    expectCountsOnly(sent, INVESTMENT_WORDS);
    fixture.close();
  });
});
