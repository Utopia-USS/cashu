// The review decide card's rows (S20, designer #21.2): thesis items through catalog labels with the
// instrument's name, the rules item through the Signals list's sentences (incognito-aware), never an id or
// the bare ticker as a title. Synthetic rows only; the expected sentences are written out by hand.
import { setLanguageForTests } from "@cashu/i18n";
import type { ReviewDecideItem } from "@cashu/store/investments/review-screen";
import type { DisplayEnv } from "../today/display";
import {
  type DecideSignalRow,
  type DecideTextContext,
  decideFacts,
  decideTitle,
  decideWhy,
} from "./decideText";

const CDR = "inst-0000000000000000000000000001";
const enUS: DisplayEnv = { locale: "en-US", privacy: false };

function ctx(env: DisplayEnv, signals: DecideSignalRow[] = []): DecideTextContext {
  return {
    instruments: [{ id: CDR, name: "CD Projekt", symbol: "CDR", currency: "PLN" }],
    signals,
    baseCurrency: "PLN",
    env,
  };
}

function item(over: Partial<ReviewDecideItem>): ReviewDecideItem {
  return {
    key: "k",
    kind: "subject",
    group: "risk",
    instrument: null,
    title: "",
    why: "",
    facts: [],
    signals: [],
    note: null,
    proposal: null,
    thesis: null,
    invalidation: null,
    exitPlan: null,
    ...over,
  } as ReviewDecideItem;
}

const thesis = (to: string, title = "CDR") =>
  item({
    key: `t:${CDR}`,
    kind: "thesis",
    instrument: CDR,
    title,
    why: to,
    health: { from: "ok", to },
  });

const heavy: DecideSignalRow = {
  gid: "sig-heavy",
  kind: "position_concentration",
  message: "CDR: 7.5% of the portfolio (max 5.0%).",
  payload: { weight: 0.075, max_weight: 0.05 },
  instrument: CDR,
  instrumentLabel: "CDR",
};
const gap: DecideSignalRow = {
  gid: "sig-gap",
  kind: "contribution_gap",
  message: "raw gap 2500",
  payload: {
    monthly_amount: "2500",
    day_of_month: 10,
    period_days: 31,
    grace_days: 10,
    last_deposit: "2026-10-02",
    days_since_last_deposit: 41,
  },
  instrument: null,
  instrumentLabel: null,
};
const rules = item({
  key: "rules",
  kind: "rules",
  group: "fix",
  facts: [heavy.message, gap.message, "Old rule: 12.5% over"],
  signals: [heavy.gid, gap.gid, "sig-not-on-phone"],
});

afterEach(() => setLanguageForTests("en"));

describe("decide card text", () => {
  it("reads a thesis item through the catalog with the instrument's name, in English", () => {
    setLanguageForTests("en");
    const c = ctx(enUS);
    expect(decideTitle(thesis("weakened"), c)).toBe("CD Projekt");
    expect(decideWhy(thesis("weakened"), c)).toBe("Thesis weakened");
    expect(decideWhy(thesis("weak"), c)).toBe("Thesis weakened");
    expect(decideWhy(thesis("invalidated"), c)).toBe("Thesis invalidated");
    expect(decideWhy(thesis("fulfilled"), c)).toBe("Thesis fulfilled");
    expect(decideWhy(thesis("something_new"), c)).toBe("The thesis changed");
    expect(decideFacts(thesis("weakened"), c)).toEqual([]);
  });

  it("reads them in Polish", () => {
    setLanguageForTests("pl");
    const c = ctx({ locale: "pl-PL", privacy: false });
    expect(decideWhy(thesis("weakened"), c)).toBe("Teza osłabiona");
    expect(decideWhy(thesis("invalidated"), c)).toBe("Teza podważona");
    expect(decideTitle(rules, c)).toBe("Z Twoich reguł");
  });

  it("never shows an id as a title", () => {
    setLanguageForTests("en");
    const unknown = "inst-ffffffffffffffffffffffffffff";
    const c = ctx(enUS);
    expect(decideTitle(item({ kind: "thesis", instrument: unknown, title: unknown }), c)).toBe(
      "A holding",
    );
    expect(decideTitle(item({ kind: "thesis", instrument: unknown, title: "Orlen" }), c)).toBe(
      "Orlen",
    );
    expect(decideTitle(rules, c)).toBe("From your rules");
  });

  it("reads the rules item as the Signals list's sentences, the missing row as the engine's safe text", () => {
    setLanguageForTests("en");
    const c = ctx(enUS, [heavy, gap]);
    expect(decideWhy(rules, c)).toBe("");
    expect(decideFacts(rules, c)).toEqual([
      "CD Projekt is 7.5% of the portfolio (your limit 5%)",
      "No contribution for 41 days (last 2 Oct). Your plan expects PLN\u00a02,500 a month by the 10th.",
      "Old rule: 12.5% over",
    ]);
  });

  it("hides the owner's amounts in incognito", () => {
    setLanguageForTests("en");
    const c = ctx({ locale: "en-US", privacy: true }, [heavy, gap]);
    expect(decideFacts(rules, c)).toEqual([
      "CD Projekt is 7.5% of the portfolio (your limit 5%)",
      "No contribution for 41 days (last 2 Oct). Your plan expects ••• a month by the 10th.",
      "Old rule: •••% over",
    ]);
  });

  it("reads a subject's lead and supporting rows as sentences", () => {
    setLanguageForTests("en");
    const c = ctx(enUS);
    const subject = item({
      kind: "subject",
      instrument: CDR,
      title: "CDR",
      why: heavy.message,
      lead: heavy as ReviewDecideItem["lead"],
      supporting: [heavy as NonNullable<ReviewDecideItem["lead"]>],
      whySource: "rule",
    });
    expect(decideTitle(subject, c)).toBe("CD Projekt");
    expect(decideWhy(subject, c)).toBe("CD Projekt is 7.5% of the portfolio (your limit 5%)");
    expect(decideFacts(subject, c)).toEqual([
      "CD Projekt is 7.5% of the portfolio (your limit 5%)",
    ]);
  });
});
