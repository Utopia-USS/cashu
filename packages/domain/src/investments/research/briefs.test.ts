/**
 * Test-for-test translation of `tests/investments/research/test_p9_briefs.py`, the research parts:
 * `details.brief` validation (lengths, forbidden words, supports / risks on macro notes only, briefs
 * only on segment / macro notes, TTL up to 90 days), the topic-note thesis relation, the
 * near-duplicate similarity (Polish examples) and the `full_refresh` run scope. Synthetic input only.
 *
 * Not translated here: `test_every_state_has_a_plain_beginner_sentence` and
 * `test_plain_of_an_inverted_curve_and_a_missing_card` test `macro.texts.plain` / `macro.regimes`
 * (scope S20); they call `forecastProblem` from this port once S20 lands.
 */
import { describe, expect, it } from "vitest";
import { utcInstant } from "./instant.js";
import { claimProblem, forecastProblem } from "./patterns.js";
import {
  directions,
  type Fingerprint,
  fingerprint,
  isNearDuplicate,
  jaccard,
  TITLE_MIN,
  tokens,
} from "./similarity.js";
import {
  BRIEF_HEADLINE_MAX,
  BRIEF_ITEM_MAX,
  BRIEF_WHY_MAX,
  ResearchInputError,
  validateNote,
  validateScope,
} from "./validation.js";

const NOW = utcInstant("2026-10-09", 12);

const TOPIC_BRIEF = {
  headline: "Rośnie popyt na chipy do centrów danych",
  why:
    "Najwięksi klienci zwiększyli wydatki na serwery z AI; producenci chipów raportują " +
    "rekordowe zamówienia.",
};
const MACRO_BRIEF = {
  headline: "Trwa hossa na giełdach",
  why: "Spółki zarabiają coraz więcej, a firmy dużo wydają na sztuczną inteligencję.",
  supports: ["Banki centralne obniżają stopy", "Zyski spółek rosną"],
  risks: ["Wyceny są wysoko", "Wzrosty opierają się na kilku wielkich spółkach"],
};

function raw(changes: Record<string, unknown> = {}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    kind: "trend",
    polarity: "positive",
    strength: 2,
    segment: "semis_ai",
    title: "Popyt na chipy AI",
    summary: "Producenci chipów raportują rekordowe zamówienia od operatorów centrów danych.",
    sources: [
      { url: "https://example.com/p9/1", publisher: "Example News", published_at: "2026-10-07" },
    ],
    details: { brief: TOPIC_BRIEF },
    ...changes,
  };
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null));
}

function problems(changes: Record<string, unknown> = {}): string {
  try {
    validateNote(raw(changes), NOW);
  } catch (error) {
    if (error instanceof ResearchInputError) return error.message;
    throw error;
  }
  throw new Error("expected ResearchInputError");
}

function brief(changes: Record<string, unknown>): Record<string, unknown> {
  return { details: { brief: { ...TOPIC_BRIEF, ...changes } } };
}

/** Python `text[:n]` (code points). */
function head(text: string, n: number): string {
  return Array.from(text).slice(0, n).join("");
}

const MACRO = { segment: "macro_risk", kind: "macro" };

describe("brief validation (test_p9_briefs.py)", () => {
  // test_a_topic_brief_is_stored_in_details
  it("a topic brief is stored in details", () => {
    const note = validateNote(raw(), NOW);
    expect(note.details).toEqual({ brief: { ...TOPIC_BRIEF, supports: [], risks: [] } });
  });

  // test_a_macro_brief_lists_supports_and_risks
  it("a macro brief lists supports and risks", () => {
    const note = validateNote(raw({ ...MACRO, details: { brief: MACRO_BRIEF } }), NOW);
    expect(note.details?.brief).toEqual(MACRO_BRIEF);
  });

  // test_brief_lengths
  it("brief lengths", () => {
    expect(problems(brief({ headline: "Hossa" }))).toContain("headline: is too short (min 8");
    const longHeadline = "x".repeat(BRIEF_HEADLINE_MAX + 1);
    expect(problems(brief({ headline: longHeadline }))).toContain(
      `headline: is too long (max ${BRIEF_HEADLINE_MAX}`,
    );
    expect(problems(brief({ why: null }))).toContain("why: is required");
    expect(problems(brief({ why: "y".repeat(281) }))).toContain(
      `why: is too long (max ${BRIEF_WHY_MAX}`,
    );
    expect(
      validateNote(raw(brief({ headline: "x".repeat(BRIEF_HEADLINE_MAX) })), NOW),
    ).toBeTruthy();
    const tooMany = {
      ...MACRO_BRIEF,
      risks: ["Ryzyko jeden", "Ryzyko dwa", "Ryzyko trzy", "Cztery"],
    };
    expect(problems({ ...MACRO, details: { brief: tooMany } })).toContain("at most 3");
    const longItem = { ...MACRO_BRIEF, supports: ["s".repeat(BRIEF_ITEM_MAX + 1)] };
    expect(problems({ ...MACRO, details: { brief: longItem } })).toContain(
      `supports[0]: is too long (max ${BRIEF_ITEM_MAX}`,
    );
    // an unknown key
    expect(problems(brief({ target: "cel" }))).toContain(
      "allowed keys: headline, why, supports, risks",
    );
  });

  // test_brief_refuses_forecast_and_call_words (parametrized)
  it.each([
    "Akcje wzrosną jeszcze w tym roku",
    "Kurs spadnie po wynikach spółek",
    "Rynek będzie rósł dalej przez lata",
    "Prognozy analityków są optymistyczne",
    "Kupuj spółki chipowe teraz",
    "Sprzedaj akcje ubezpieczycieli",
    "Analitycy podnieśli cel cenowy spółki",
    "Akcje wzrosna jeszcze w tym roku",
    "Ceny spadna po wynikach",
    "Rynek bedzie rosl dalej",
    "Rynek urośnie w kolejnym roku",
    "Ropa podrożeje zimą",
    "Miedź stanieje po decyzji Chin",
    "Kurs odbije po korekcie",
  ])("brief refuses forecast and call words: %s", (text) => {
    expect(forecastProblem(text)).toBe(true);
    expect(problems(brief({ headline: head(text, 80) }))).toContain("reads like a forecast");
    expect(problems(brief({ why: `${text} i coś jeszcze.` }))).toContain("reads like a forecast");
  });

  // test_plain_condition_words_are_fine
  it("plain condition words are fine", () => {
    for (const text of [
      "Niskie stopy sprzyjają spółkom wzrostowym",
      "Wyceny są wysoko, więc rynek jest wrażliwy na złe wiadomości",
      "Coraz więcej kupujących wraca na rynek gier",
      "Spadły wydatki na reklamę w grach",
    ]) {
      expect(forecastProblem(text), text).toBe(false);
    }
  });

  // test_an_attributed_institutional_trend_forecast_passes (parametrized)
  it.each([
    "MFW prognozuje wzrost PKB USA o 2,1 % w 2027",
    "Fed w projekcji (dot plot) zakłada stopy 3,4 % na koniec 2026",
    "Według projekcji NBP inflacja spadnie do 2,5 % w 2027",
    "EBC prognozuje inflację w strefie euro na 2,0 % w 2026",
    "IEA szacuje, że popyt na prąd wzrośnie o 4 % rocznie do 2027",
    "OECD przewiduje, że handel światowy urośnie o 2,8 % w 2026",
  ])("an attributed institutional trend forecast passes: %s", (text) => {
    expect(forecastProblem(text), text).toBe(false);
    const note = validateNote(
      raw({
        ...MACRO,
        summary: `${text}. Dane z raportu instytucji.`,
        details: {
          brief: {
            ...MACRO_BRIEF,
            why: `${text}.`,
            supports: [head(text, 90)],
            risks: ["Wyceny są wysoko"],
          },
        },
      }),
      NOW,
    );
    expect(note.details?.brief).toMatchObject({ why: `${text}.` });
    expect(validateNote(raw(brief({ why: `${text}.` })), NOW)).toBeTruthy();
  });

  // test_unattributed_own_analyst_and_price_forecasts_are_still_refused (parametrized)
  it.each([
    "Prognozujemy, że PKB USA wzrośnie o 2 % w 2027",
    "Analitycy prognozują wzrost zysków spółek o 10 %",
    "Konsensus analityków według MFW prognozuje wzrost PKB o 2 %",
    "S&P 500 wzrośnie do 7000 punktów w 2027",
    "MFW prognozuje, że S&P 500 wzrośnie do 7000 punktów",
    "Fed prognozuje, że wyceny spółek spadną w 2027",
    "Według OECD kurs dolara spadnie do 3,5 zł",
    "MFW prognozuje wzrost PKB. Rynek będzie rósł dalej",
    "Rynek będzie rósł, bo tak prognozuje rynek",
    "Według MFW warto kupić akcje banków",
  ])("unattributed, own, analyst and price forecasts are still refused: %s", (text) => {
    expect(forecastProblem(text) || claimProblem(text), text).toBe(true);
    expect(problems(brief({ why: `${text}.` }))).toContain("reads like a forecast");
  });

  // test_a_note_summary_may_cite_an_institutional_trend_forecast_but_not_a_price_call
  it("a note summary may cite an institutional trend forecast but not a price call", () => {
    const ok = "Według projekcji NBP inflacja spadnie do 2,5 % w 2027; RPP utrzymała stopy.";
    expect(validateNote(raw({ summary: ok }), NOW).summary).toBe(ok);
    for (const bad of [
      "Kurs wzrośnie do 50 zł w tym roku po wynikach.",
      "Fed prognozuje, że kurs akcji banków wzrośnie do 50 USD.",
    ]) {
      expect(problems({ summary: bad }), bad).toContain("notes carry sourced facts");
    }
  });

  // test_supports_and_risks_only_on_macro_notes
  it("supports and risks only on macro notes", () => {
    expect(problems(brief({ supports: ["Niskie stopy sprzyjają"] }))).toContain(
      "only a macro brief lists supports / risks",
    );
  });

  // test_a_brief_only_on_segment_or_macro_notes
  it("a brief only on segment or macro notes", () => {
    expect(problems({ segment: null, kind: "news" })).toContain(
      "only a segment or macro note carries a brief",
    );
  });

  // test_brief_notes_may_live_90_days
  it("brief notes may live 90 days", () => {
    expect(validateNote(raw({ expires_in_days: 90 }), NOW).expiresInDays).toBe(90);
    expect(problems({ expires_in_days: 91 })).toContain(
      "expires_in_days: must be between 1 and 90",
    );
  });
});

describe("topic thesis relation (test_p9_briefs.py)", () => {
  // test_a_topic_note_may_bear_on_its_topic_thesis
  it("a topic note may bear on its topic thesis", () => {
    for (const relation of ["supports", "weakens", "invalidates"]) {
      const note = validateNote(raw({ thesis_relation: relation }), NOW);
      expect([note.thesisRelation, note.thesisField]).toEqual([relation, "thesis"]);
    }
    expect(
      validateNote(raw({ thesis_relation: "weakens", thesis_field: "thesis" }), NOW),
    ).toBeTruthy();
    expect(problems({ thesis_relation: "weakens", thesis_field: "exit_plan" })).toContain(
      "use thesis",
    );
    expect(problems({ thesis_relation: "neutral" })).toContain(
      "a topic note bears on its topic thesis",
    );
    expect(
      problems({ segment: "macro_rates", kind: "macro", thesis_relation: "supports" }),
    ).toContain("a macro note has no thesis");
  });
});

function fp(title: string, summary = "", headline: string | null = null): Fingerprint {
  return fingerprint(title, summary, headline);
}

describe("near duplicates (test_p9_briefs.py)", () => {
  // test_the_same_fact_rephrased_is_a_near_duplicate (parametrized)
  it.each([
    [
      "Nvidia podnosi prognozę przychodów na kwartał",
      "Nvidia podniosła prognozę przychodów kwartalnych",
    ],
    ["Rośnie popyt na chipy do centrów danych", "Popyt na chipy do centrów danych dalej rośnie"],
    [
      "UnitedHealth: zabójstwo prezesa wstrząsa branżą",
      "Zabójstwo prezesa UnitedHealth wstrząsnęło branżą ubezpieczeń",
    ],
    ["Wyniki CD Projekt za 3 kwartał", "CD Projekt: wyniki za 3 kwartał"],
  ])("the same fact rephrased is a near duplicate: %s", (old, next) => {
    expect(isNearDuplicate(fp(next), fp(old))).toBe(true);
  });

  // test_another_fact_about_the_same_company_is_allowed (parametrized)
  it.each([
    ["Nvidia podnosi prognozę przychodów", "Nvidia ogłasza skup akcji za 50 mld USD"],
    ["Ludzie grają więcej według nowych badań", "Mniej pieniędzy napływa do branży gier"],
    ["CD Projekt przesuwa premierę gry", "CD Projekt kupuje studio w Kanadzie"],
  ])("another fact about the same company is allowed: %s", (old, next) => {
    expect(isNearDuplicate(fp(next), fp(old))).toBe(false);
  });

  // test_reversals_and_new_numbers_are_never_near_duplicates (parametrized)
  it.each([
    // the review's pairs (HIGH-2): a reversal is a new fact
    ["Nvidia podnosi prognozę przychodów", "Nvidia obniża prognozę przychodów"],
    ["Fed obniżył stopy procentowe", "Fed podniósł stopy procentowe"],
    ["Oprocentowanie obligacji w USA rośnie", "Oprocentowanie obligacji w USA spada"],
    ["Popyt na chipy w Azji rośnie", "Popyt na chipy w Azji spada"],
    ["TSMC zwiększa nakłady inwestycyjne", "TSMC zmniejsza nakłady inwestycyjne"],
    ["Rynek chipów w konsolidacji", "Rynek chipów wychodzi z konsolidacji"],
    ["Dolar się umacnia wobec euro", "Dolar słabnie wobec euro"],
    ["Nvidia raises revenue guidance", "Nvidia cuts revenue guidance"],
    // MED-1: numbers stay in the title
    ["Akcje spadły o 10 % od szczytu", "Akcje spadły o 20 % od szczytu"],
    ["Wyniki CD Projekt za 2 kwartał", "Wyniki CD Projekt za 3 kwartał"],
  ])("reversals and new numbers are never near duplicates: %s", (old, next) => {
    expect(isNearDuplicate(fp(next), fp(old))).toBe(false);
  });

  // test_polarity_or_relation_differs_never_a_near_duplicate
  it("polarity or relation differs: never a near duplicate", () => {
    const title = "Nvidia podnosi prognozę przychodów na kwartał";
    const a = fingerprint(title, "", null, { polarity: "positive", relation: "supports" });
    expect(
      isNearDuplicate(
        a,
        fingerprint(title, "", null, { polarity: "positive", relation: "supports" }),
      ),
    ).toBe(true);
    expect(
      isNearDuplicate(
        a,
        fingerprint(title, "", null, { polarity: "negative", relation: "supports" }),
      ),
    ).toBe(false);
    expect(
      isNearDuplicate(
        a,
        fingerprint(title, "", null, { polarity: "positive", relation: "invalidates" }),
      ),
    ).toBe(false);
  });

  // test_thresholds_are_strict_and_need_four_tokens
  it("thresholds are strict and need four tokens", () => {
    // 3 of 5 tokens = 0.6 exactly: not above the threshold
    expect(jaccard(tokens("alfa beta gamma delta"), tokens("alfa beta gamma epsilon"))).toBe(0.6);
    expect(isNearDuplicate(fp("alfa beta gamma delta"), fp("alfa beta gamma epsilon"))).toBe(false);
    // identical, but fewer than 4 tokens: too little to judge
    expect(isNearDuplicate(fp("Hossa trwa"), fp("Trwa hossa"))).toBe(false);
  });

  // test_a_new_brief_with_changed_drivers_passes_the_headline_rule
  it("a new brief with changed drivers passes the headline rule", () => {
    const old = fingerprint(
      "Zyski spółek z S&P 500 w III kwartale wyżej",
      "Według FactSet zyski spółek wyższe niż rok temu.",
      "Trwa hossa na giełdach światowych",
      { why: "Spółki zarabiają coraz więcej, a firmy dużo wydają na sztuczną inteligencję." },
    );
    const sameWhy = fingerprint(
      "Dane z rynku pracy w USA mocne",
      "Rynek pracy w USA mocny, płace stabilne według BLS.",
      "Hossa na giełdach światowych trwa",
      { why: "Spółki zarabiają coraz więcej, a firmy dużo wydają na sztuczną inteligencję." },
    );
    const newWhy = fingerprint(
      "Dane z rynku pracy w USA mocne",
      "Rynek pracy w USA mocny, płace stabilne według BLS.",
      "Hossa na giełdach światowych trwa",
      { why: "Banki centralne obniżają koszt kredytu, a rynek pracy pozostaje mocny." },
    );
    expect(isNearDuplicate(sameWhy, old)).toBe(true);
    expect(isNearDuplicate(newWhy, old)).toBe(false);
  });

  // test_body_similarity_catches_a_new_title_on_the_same_text
  it("body similarity catches a new title on the same text", () => {
    const summary =
      "Według raportu Newzoo gracze spędzają więcej czasu przy grach mobilnych, a liczba " +
      "aktywnych graczy w Europie wzrosła rok do roku o kilka procent.";
    const old = fp("Gracze grają dłużej", summary, "Ludzie grają więcej");
    const next = fp("Raport Newzoo o czasie gry", `${summary} Dane za trzeci kwartał.`);
    expect(jaccard(old.title, next.title)).toBeLessThan(TITLE_MIN);
    expect(isNearDuplicate(next, old)).toBe(true);
  });

  // test_tokens_normalize
  it("tokens normalize", () => {
    expect(tokens("Złoto, ŁÓDŹ i 2025 r.")).toEqual(new Set(["zlot", "lodz"]));
    expect(tokens("Złoto 2025", { numbers: true })).toEqual(new Set(["zlot", "2025"]));
    expect(directions("Popyt rośnie, ceny spadły")).toEqual(new Set(["up", "down"]));
    expect(directions("Rynek w konsolidacji")).toEqual(new Set());
    expect(tokens("prognozę prognozy")).toEqual(new Set(["prog"]));
    expect(tokens(null)).toEqual(new Set());
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0.0);
  });
});

describe("full_refresh scope (test_p9_briefs.py)", () => {
  // test_full_refresh_is_never_scheduled
  it("full refresh is never scheduled", () => {
    expect(() => validateScope({ full_refresh: true, scheduled: true })).toThrow(
      /never a scheduled run/,
    );
  });

  // test_full_refresh_scope_flag
  it("full refresh scope flag", () => {
    expect(validateScope({ full_refresh: true }).fullRefresh).toBe(true);
    expect(validateScope({}).fullRefresh).toBe(false);
    // covers everything
    expect(validateScope({ full_refresh: true }).held).toBe(true);
    expect(() => validateScope({ full_refresh: "yes" })).toThrow(/scope\.full_refresh/);
  });
});
