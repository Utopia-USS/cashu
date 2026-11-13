// The pure Today rules: when the month-closed state takes Today's place, and how each attention reason
// becomes a "Worth a look" row in both languages, with amounts hidden in privacy mode.
import { D } from "@cashu/domain";
import type { BananaScale } from "@cashu/domain/core";
import type { AttentionItem } from "@cashu/domain/core/attention";
import { setLanguageForTests } from "@cashu/i18n";
import { type DisplayEnv, monthName } from "./display";
import { attentionRowOf, showsClosed } from "./todayRules";

const EN: DisplayEnv = { locale: "en-US", privacy: false };
const PL: DisplayEnv = { locale: "pl-PL", privacy: false };

afterEach(() => setLanguageForTests("en"));

/** Intl's no-break spaces as plain ones, so the expectations read as written. */
const plain = (text: string | undefined) => text?.replace(/[\u00a0\u202f]/gu, " ");
const plainRow = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, typeof v === "string" ? plain(v) : v]),
  );

describe("showsClosed", () => {
  it("shows the closed month in the first three days, then until the plan is saved", () => {
    expect(showsClosed("2026-12-01", true, true, null)).toBe(true);
    expect(showsClosed("2026-12-03", true, true, null)).toBe(true);
    expect(showsClosed("2026-12-04", true, true, null)).toBe(false);
    expect(showsClosed("2026-12-04", true, false, null)).toBe(true);
    expect(showsClosed("2026-12-28", true, false, null)).toBe(true);
  });

  it("stays away for the month the owner put away, and comes back for the next one", () => {
    expect(showsClosed("2026-12-02", true, false, "2026-11")).toBe(false);
    expect(showsClosed("2026-12-20", true, false, "2026-11")).toBe(false);
    expect(showsClosed("2026-12-02", true, false, "2026-10")).toBe(true);
    expect(showsClosed("2027-01-02", true, true, "2026-11")).toBe(true);
  });

  it("never shows a month that is not complete", () => {
    expect(showsClosed("2026-12-01", false, false, null)).toBe(false);
    expect(showsClosed("2026-12-20", false, true, null)).toBe(false);
  });
});

const uncategorized: AttentionItem = {
  tier: 1,
  subject: { kind: "uncategorized", id: "uncategorized" },
  reason: {
    kind: "uncategorized_sum",
    sum: D("2496.00"),
    shareOfSpent: 0.31,
    count: 7,
    largest: { payee: "IKEA", date: "2026-11-10", amount: D("-2180.00") },
  },
  magnitude: { kind: "percent", value: 0.31 },
  target: { kind: "triage" },
};

const bill: AttentionItem = {
  tier: 1,
  subject: { kind: "bill", id: "gym" },
  reason: {
    kind: "bill_uncovered",
    payee: "CityFit gym",
    when: "2026-11-18",
    shortfall: D("59.00"),
    account: { id: "a1", name: "Erste Account" },
  },
  magnitude: { kind: "money", value: D("59.00"), currency: "PLN", signed: false },
  target: { kind: "bill", key: "gym" },
};

const position: AttentionItem = {
  tier: 2,
  subject: { kind: "position", id: "cdr" },
  reason: {
    kind: "position",
    instrument: { id: "cdr", name: "CD Projekt" },
    alertFired: true,
    researchVerdict: "weakens",
    dayMove: -0.094,
  },
  magnitude: { kind: "percent", value: 0.074 },
  target: { kind: "position", instrument: "cdr" },
};

const priceUp: AttentionItem = {
  tier: 4,
  subject: { kind: "payee", id: "netflix" },
  reason: {
    kind: "payee_price_up",
    payee: "Netflix",
    from: D("49.00"),
    to: D("60.00"),
    yearlyEffect: D("132.00"),
    nextDate: "2026-11-13",
  },
  magnitude: { kind: "money", value: D("132.00"), currency: "PLN", signed: true },
  target: { kind: "none" },
};

const newRecurring: AttentionItem = {
  tier: 4,
  subject: { kind: "payee", id: "gym" },
  reason: { kind: "payee_new_recurring", payee: "CityFit", amount: D("159.00"), cadenceDays: 30 },
  magnitude: { kind: "money", value: D("159.00"), currency: "PLN", signed: false },
  target: { kind: "none" },
};

describe("attentionRowOf", () => {
  const openTriage = jest.fn();

  it("maps every reason to its icon, tone, copy and magnitude (English)", () => {
    setLanguageForTests("en");
    const rows = [uncategorized, bill, position, priceUp, newRecurring].map((item) =>
      attentionRowOf(item, "PLN", EN, { openTriage }),
    );
    expect(rows.map(({ onPress: _, ...row }) => plainRow(row))).toEqual([
      {
        key: "uncategorized:uncategorized",
        icon: "tag",
        tone: "warn",
        title: "PLN 2,496 not categorized",
        sub: "mostly IKEA, Tue, Nov 10 · your projection may be off",
        magnitude: "31%",
        magnitudeLabel: "of spending",
      },
      {
        key: "bill:gym",
        icon: "calendar",
        tone: "neg",
        title: "Not enough money for CityFit gym",
        sub: "due November 18 from Erste Account",
        magnitude: "PLN 59",
        magnitudeLabel: "short",
      },
      {
        key: "position:cdr",
        icon: "bell",
        tone: "neg",
        title: "CD Projekt needs a look",
        sub: "your alert fired · research: weakens your thesis",
        magnitude: "7%",
        magnitudeLabel: "of portfolio",
      },
      {
        key: "payee:netflix",
        icon: "calendar",
        tone: "default",
        title: "Netflix costs more",
        sub: "PLN 49.00 to PLN 60.00, from November 13",
        magnitude: "+PLN 132",
        magnitudeLabel: "a year",
      },
      {
        key: "payee:gym",
        icon: "calendar",
        tone: "default",
        title: "New regular payment: CityFit",
        sub: "every 30 days",
        magnitude: "PLN 159",
        magnitudeLabel: "per charge",
      },
    ]);
    expect(rows.map((row) => row.onPress === null)).toEqual([false, true, true, true, true]);
    rows[0]?.onPress?.();
    expect(openTriage).toHaveBeenCalledTimes(1);
  });

  it("speaks Polish", () => {
    setLanguageForTests("pl");
    const [first, second, , fourth] = [uncategorized, bill, position, priceUp].map((item) =>
      attentionRowOf(item, "PLN", PL, { openTriage }),
    );
    expect(plain(first?.title)).toBe(`2496 zł bez kategorii`);
    expect(plain(second?.sub)).toBe("płatne 18 listopada z konta Erste Account");
    expect(plain(fourth?.sub)).toBe("z 49,00 zł na 60,00 zł, od 13 listopada");
    expect(fourth?.magnitudeLabel).toBe("rocznie");
  });

  it("a position row names the week's move and its reasons, and opens the alert sheet or the position", () => {
    setLanguageForTests("en");
    const openAlert = jest.fn();
    const openPosition = jest.fn();
    const actions = { openTriage, openAlert, openPosition };
    const row = attentionRowOf(position, "PLN", EN, actions, {
      cdr: { signal: "sig-cdr", week: -0.094 },
    });
    expect(plain(row.title)).toBe("CD Projekt: -9.4% this week");
    expect(row.sub).toBe("your alert fired · research: weakens your thesis");
    row.onPress?.();
    expect(openAlert).toHaveBeenCalledWith("sig-cdr");

    const researchOnly: AttentionItem = {
      ...position,
      reason: { ...position.reason, alertFired: false, researchVerdict: "invalidates" } as never,
    };
    const quiet = attentionRowOf(researchOnly, "PLN", EN, actions, {
      cdr: { signal: null, week: null },
    });
    expect(quiet.title).toBe("CD Projekt needs a look");
    expect(quiet.sub).toBe("research: invalidates your thesis");
    quiet.onPress?.();
    expect(openPosition).toHaveBeenCalledWith("cdr");

    const moved: AttentionItem = {
      ...position,
      reason: { ...position.reason, alertFired: false, researchVerdict: null } as never,
    };
    expect(plain(attentionRowOf(moved, "PLN", EN, { openTriage }).sub)).toBe("-9.4% today");
    expect(attentionRowOf(moved, "PLN", EN, { openTriage }).onPress).toBeNull();

    setLanguageForTests("pl");
    const pl = attentionRowOf(position, "PLN", PL, actions, {
      cdr: { signal: "sig-cdr", week: -0.094 },
    });
    expect(plain(pl.title)).toBe("CD Projekt: -9,4% w tym tygodniu");
    expect(pl.sub).toBe("Twój alert zadziałał · research: osłabia Twoją tezę");
  });

  it("hides amounts in privacy mode: bananas with a scale, dots without", () => {
    setLanguageForTests("en");
    const bananas: BananaScale = { anchor: "salary", perPln: 0.08, plnRates: {} };
    const shown = attentionRowOf(priceUp, "PLN", { ...EN, privacy: true, bananas }, { openTriage });
    expect(shown.magnitude).toBe("+🍌 10.6");
    expect(shown.sub).not.toContain("49");
    const masked = attentionRowOf(bill, "PLN", { ...EN, privacy: true }, { openTriage });
    expect(masked.magnitude).toBe("•••");
    // Shares stay.
    const share = attentionRowOf(uncategorized, "PLN", { ...EN, privacy: true }, { openTriage });
    expect(share.magnitude).toBe("31%");
  });
});

describe("monthName", () => {
  it("gives the title, the 'of' form and the plain name", () => {
    expect(monthName("2026-11", "en-US")).toEqual({
      title: "November",
      of: "November",
      name: "November",
    });
    expect(monthName("2026-11", "pl-PL")).toEqual({
      title: "Listopad",
      of: "listopada",
      name: "listopad",
    });
  });
});
