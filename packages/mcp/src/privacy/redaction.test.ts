// The redactor's rules, one test each: every sensitivity label in both privacy modes, text scrubbing,
// the final leak check, fail-closed behaviour for unlabelled values and data-derived keys, and the
// person-name guard. Every value is invented.
import { D, parseDateTime } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import * as L from "./labels.js";
import { fold, looksLikePerson, NameGuard, normalize } from "./names.js";
import { pyDumps } from "./pyJson.js";
import { LeakDetected, leakCheck, Redactor, UnlabelledValue } from "./redactor.js";
import { isinValid, scrubText } from "./scrub.js";

const STRICT = new Redactor({ privacy: "strict" });
const AMOUNTS = new Redactor({ privacy: "amounts" });
const bytes = (ch: string) => new TextEncoder().encode(ch.repeat(32));

// ------------------------------------------------------------------ labels x modes

it("test_identifier_is_dropped_in_both_modes", () => {
  const tree = { iban: L.identifier("PL61109010140000071219812874"), keep: L.count(1) };
  expect(STRICT.apply(tree)).toEqual({ keep: 1n });
  expect(AMOUNTS.apply(tree)).toEqual({ keep: 1n });
});

it("test_amount_dropped_in_strict_sent_in_amounts", () => {
  const tree = { value: L.amount(D("987654.32")), weight: L.pct(0.25) };
  expect(STRICT.apply(tree)).toEqual({ weight: 0.25 });
  expect(AMOUNTS.apply(tree)).toEqual({ value: 987654.32, weight: 0.25 });
});

it("test_amount_in_a_list_is_removed_in_strict", () => {
  const tree = { values: [L.amount(1n), L.pct(0.5), L.amount(2n)] };
  expect(STRICT.apply(tree)).toEqual({ values: [0.5] });
  expect(AMOUNTS.apply(tree)).toEqual({ values: [1n, 0.5, 2n] });
});

describe("test_safe_labels_are_sent_and_type_checked", () => {
  it.each([
    ["strict", STRICT],
    ["amounts", AMOUNTS],
  ])("%s", (_name, redactor) => {
    const tree = {
      pct: L.pct(D("0.1234567")),
      date: L.date("2026-01-02"),
      when: L.date(parseDateTime("2026-01-02T03:04:00+00:00")),
      category: L.category("groceries"),
      symbol: L.symbol("AAPL"),
      isin: L.symbol("US0378331005"),
      count: L.count(3),
      ref: L.ref(17),
      payee: L.ref("payee:0123456789"),
      flag: L.flag(true),
      account: L.account("mBank checking 1"),
      none: L.text(null),
    };
    expect(redactor.apply(tree)).toEqual({
      pct: 0.123457,
      date: "2026-01-02",
      when: "2026-01-02T03:04:00+00:00",
      category: "groceries",
      symbol: "AAPL",
      isin: "US0378331005",
      count: 3n,
      ref: 17n,
      payee: "payee:0123456789",
      flag: true,
      account: "mBank checking 1",
      none: null,
    });
  });
});

describe("test_wrong_types_fail_closed", () => {
  it.each([
    ["count(1.5)", L.count(1.5)],
    ["count(True)", new L.Labelled(true, "count")],
    ["flag(1)", new L.Labelled(1n, "flag")],
    ["percent '10%'", new L.Labelled("10%", "percent")],
    ["date('yesterday')", L.date("yesterday")],
    ["ref('x y')", L.ref("x y")],
  ])("%s", (_name, leaf) => {
    expect(() => STRICT.apply({ x: leaf })).toThrow(UnlabelledValue);
  });
});

describe("test_unlabelled_leaf_fails_closed", () => {
  it.each([1n, 2.5, "text", D("1"), true, new Map()])("%s", (raw) => {
    const bad = raw as unknown as L.LabelledTree;
    expect(() => STRICT.apply({ x: bad })).toThrow(UnlabelledValue);
    expect(() => AMOUNTS.apply({ nested: [{ x: bad }] })).toThrow(UnlabelledValue);
  });
});

it("test_data_never_becomes_a_key", () => {
  expect(() => STRICT.apply({ "Konto Jana": L.count(1) })).toThrow(UnlabelledValue);
  expect(() => STRICT.apply({ PL61109010140000071219812874: L.count(1) })).toThrow(UnlabelledValue);
});

it("test_text_is_scrubbed_by_mode", () => {
  const tree = { message: L.text("Bucket x is 12.5 pp over (1 234,56 PLN above target).") };
  expect((STRICT.apply(tree) as { message: string }).message).toBe(
    "Bucket x is 12.5 pp over ([amount] above target).",
  );
  expect((AMOUNTS.apply(tree) as { message: string }).message).toBe(
    "Bucket x is 12.5 pp over (1 234,56 PLN above target).",
  );
});

it("test_merchant_private_person_becomes_a_ref_in_both_modes", () => {
  const guard = new NameGuard({
    profileId: 1,
    names: ["ZOFIA WISNIEWSKA"],
    privatePayees: ["ZOFIA WISNIEWSKA"],
    secret: bytes("k"),
  });
  for (const privacy of ["strict", "amounts"]) {
    const out = new Redactor({ privacy, guard }).apply({
      a: L.merchant("ZOFIA WISNIEWSKA"),
      b: L.merchant("BIEDRONKA 123"),
    }) as { a: string; b: string };
    expect(out.a.startsWith("payee:") && out.a.length === 16).toBe(true);
    expect(out.b).toBe(privacy === "strict" ? "BIEDRONKA [amount]" : "BIEDRONKA 123");
  }
});

// ------------------------------------------------------------------ text scrubbing

const IDENTIFIERS = [
  "PL61109010140000071219812874",
  "PL61 1090 1014 0000 0712 1981 2874",
  "acct 61109010140000071219812874 end",
  "99 1140 0000 0000 0000 0000 0001",
  "card 4111 1111 1111 1111",
  "tel +48 600 700 800",
  "DE89370400440532013000",
  "GB82WEST12345698765432",
];

const digitsOf = (s: string) => Array.from(s).filter((c) => /\p{Nd}/u.test(c));

describe("test_identifiers_are_always_scrubbed", () => {
  for (const strict of [true, false]) {
    it.each(IDENTIFIERS)(`%s (strict=${strict})`, (t) => {
      const out = scrubText(t, { strict });
      expect(digitsOf(out.replaceAll("+", "")).length === 0 || out.includes("[")).toBe(true);
      expect(digitsOf(out).length).toBeLessThan(9);
    });
  }
});

describe("test_strict_scrubs_amounts_and_numbers_keeps_dates", () => {
  it.each([
    ["plan 1500 PLN per month", "plan [amount] per month"],
    ["value 1 234 567,89 zł", "value [amount]"],
    ["worth $1,234.50 now", "worth [amount] now"],
    ["EUR 12.30 fee", "[amount] fee"],
    ["cost 4321.09", "cost [amount]"],
    // S37fix D3: every other number with 2+ significant digits, bare years too; R1 / R2 keep
    // percentages, percentage points, non-money units and file positions (up to 3 digits)
    ["total 98765 in 2026", "total [amount] in [amount]"],
    ["37.3% of the portfolio, 2.5 pp drift", "37.3% of the portfolio, 2.5 pp drift"],
    ["5000% of the portfolio", "[amount]% of the portfolio"],
    ["No deposit for 45 days (last on 2026-01-05)", "No deposit for 45 days (last on 2026-01-05)"],
    ["1500 days of history", "[amount] days of history"],
    ["ISIN US0378331005 held", "ISIN [iban] held"], // free text: no ISIN exemption
    ["rule rebalance_check, row 12", "rule rebalance_check, row 12"],
    ["5 000 dni zaległości kwota 5000", "[amount] dni zaległości kwota [amount]"],
  ])("%s", (t, expected) => {
    expect(scrubText(t, { strict: true })).toBe(expected);
  });
});

it("test_amounts_mode_keeps_amounts_but_not_identifiers", () => {
  const t = "1500 PLN from PL61109010140000071219812874 (a.b@example.com)";
  expect(scrubText(t, { strict: false })).toBe("1500 PLN from [iban] ([email])");
});

it("test_known_names_are_masked_case_and_diacritic_insensitive", () => {
  const guard = new NameGuard({ profileId: 1, names: ["ZOFIA WISNIEWSKA", "KOWALCZYK"] });
  const t = "Rozmowa z Zofia Wiśniewska i p. kowalczyk; Kowalczykowa zostaje.";
  // S37fix D4: an inflected form ("Kowalczykowa", Mrs Kowalczyk) is masked too
  expect(guard.mask(t)).toBe("Rozmowa z [name] i p. [name]; [name] zostaje.");
});

it("test_isin_check_digit", () => {
  expect(isinValid("US0378331005")).toBe(true);
  expect(isinValid("IE00B4L5Y983")).toBe(true);
  expect(isinValid("US0378331006")).toBe(false);
  expect(isinValid("PL61109010140000071219812874")).toBe(false);
});

// ------------------------------------------------------------------ leak check

it("test_leak_check_refuses_identifier_like_values_in_any_mode", () => {
  for (const strict of [true, false]) {
    expect(() => leakCheck({ note: "PL61109010140000071219812874" }, { strict })).toThrow(
      LeakDetected,
    );
    expect(() => leakCheck({ rows: ["1234567890123"] }, { strict })).toThrow(LeakDetected);
  }
  leakCheck({ at: "2026-01-02T03:04:05.123456+00:00" }, { strict: true });
  // an ISIN-shaped run only passes when a symbol field sent it
  expect(() => leakCheck({ isin: "US0378331005" }, { strict: true })).toThrow(LeakDetected);
  leakCheck({ isin: "US0378331005" }, { strict: true, isins: new Set(["US0378331005"]) });
});

it("test_symbol_fields_carry_isins_and_vat_ids_in_text_are_scrubbed", () => {
  const redactor = new Redactor({ privacy: "strict" });
  const out = redactor.apply({ isin: L.symbol("US0378331005"), note: L.text("NIP PL5260001248") });
  expect(out).toEqual({ isin: "US0378331005", note: "NIP [iban]" });
  leakCheck(out, { strict: true, isins: redactor.isins });
});

it("test_leak_check_refuses_numbers_under_money_keys_in_strict", () => {
  expect(() => leakCheck({ positions: [{ value: 10.0 }] }, { strict: true })).toThrow(LeakDetected);
  leakCheck({ positions: [{ value: 10.0 }] }, { strict: false });
  leakCheck({ positions: [{ weight: 0.1 }] }, { strict: true });
});

// ------------------------------------------------------------------ name guard

describe("test_looks_like_person", () => {
  it.each([
    ["ZOFIA WISNIEWSKA", true],
    ["Anna Nowak-Kowalska", true],
    ["J. Z. KOWALSKI", true],
    ["Grzegorz Brzęczyszczykiewicz", true],
    ["WSPOLNOTA MIESZKANIOWA", false],
    ["ABC SP. Z O.O.", false],
    ["NETFLIX.COM", false],
    ["ORLEN STACJA 123", false],
    ["BIEDRONKA", false],
  ])("%s", (t, person) => {
    expect(looksLikePerson(t)).toBe(person);
  });
});

it("test_payee_ref_is_stable_and_resolvable", () => {
  const guard = new NameGuard({ profileId: 7, privatePayees: ["JAN NOWAK"], secret: bytes("s") });
  const ref = guard.payeeRef("Jan Nowak");
  expect(ref).toBe(guard.payeeRef("JAN NOWAK"));
  expect(guard.resolve(ref, ["BIEDRONKA", "JAN NOWAK"])).toBe("JAN NOWAK");
  expect(guard.resolve("payee:0000000000", ["JAN NOWAK"])).toBeNull();
  expect(guard.resolve("biedronka", ["BIEDRONKA"])).toBe("BIEDRONKA");
  const other = new NameGuard({ profileId: 8, privatePayees: ["JAN NOWAK"], secret: bytes("s") });
  expect(other.payeeRef("JAN NOWAK")).not.toBe(ref); // refs are per profile
});

it("test_fold_and_normalize", () => {
  expect(fold("Łoś Żółć")).toBe("LOS ZOLC");
  expect(normalize("  sp. z o.o.,  ABC ")).toBe("SP Z OO ABC");
});

// ------------------------------------------------------------------ review findings

it("test_symbol_label_is_scrubbed_for_names_and_amounts", () => {
  const guard = new NameGuard({ profileId: 1, names: ["JAN KOWALSKI", "KOWALSKI"] });
  const out = new Redactor({ privacy: "strict", guard }).apply({
    a: L.symbol("JAN KOWALSKI 15000"),
    b: L.symbol("KOWALSKI"),
    c: L.symbol("CDR"),
    d: L.symbol("0700"),
    e: L.symbol("123456"),
  }) as Record<string, string>;
  expect(pyDumps(out)).not.toContain("KOWALSKI");
  expect(out.a).not.toContain("15000");
  // S37fix F8: in strict a symbol without a letter is a number ("0700" too)
  expect([out.c, out.d, out.e]).toEqual(["CDR", "[amount]", "[amount]"]);
  expect(new Redactor({ privacy: "amounts", guard }).apply({ d: L.symbol("0700") })).toEqual({
    d: "0700",
  });
});

describe("test_account_numbers_with_other_separators", () => {
  const texts = [
    "PL61  1090  1014  0000  0712  1981  2874",
    "61.1090.1014.0000.0712.1981.2874",
    "61/1090/1014/0000/0712/1981/2874",
    "PL61_1090_1014_0000_0712_1981_2874",
    "konto U1234567 u brokera",
    "acct 12345678 ok",
    "4111.1111.1111.1111",
  ];
  for (const strict of [true, false]) {
    it.each(texts)(`%s (strict=${strict})`, (t) => {
      expect(digitsOf(scrubText(t, { strict })).length).toBeLessThan(6);
    });
  }
});

it("test_leak_check_sees_double_spaced_ibans", () => {
  expect(() =>
    leakCheck({ note: "PL61  1090  1014  0000  0712  1981  2874" }, { strict: false }),
  ).toThrow(LeakDetected);
});

describe("test_strict_money_words", () => {
  it.each([
    "850 złotych",
    "999 pln",
    "500 euro",
    "12 tys. zł",
    "100k",
    "kwota 2000",
    "750 RON",
    "1,5 mln",
    "valued at the last known price 950 from x",
    "cash 12.50 left",
  ])("%s", (t) => {
    expect(digitsOf(scrubText(t, { strict: true }))).toEqual([]);
  });
});

describe("test_dates_and_periods_survive", () => {
  it.each(["2026-09", "2026-Q3", "09/2026", "2026-01-05", "05.01.2026"])("%s", (t) => {
    expect(scrubText(t, { strict: true })).toBe(t);
  });
});

describe("test_bare_years_are_numbers_in_strict", () => {
  // S37fix D3, N2: a year is kept only inside a validated date format; "za 2000" may be a price
  it.each(["2026", "in 2026", "since 2019", "za 2000", "stycznia 2026", "May 2026"])("%s", (t) => {
    const out = scrubText(t, { strict: true });
    expect(out.includes("20") || out.includes("19")).toBe(false);
    expect(scrubText(t, { strict: false })).toBe(t);
  });
});

it("test_payee_refs_never_contain_digits", () => {
  const guard = new NameGuard({ profileId: 1, privatePayees: ["A B"], secret: bytes("x") });
  for (let i = 0; i < 300; i++) expect(guard.payeeRef(`PERSON ${i}`)).toMatch(/^payee:[a-p]{10}$/);
});

it("test_names_in_other_order_and_with_an_address", () => {
  const guard = new NameGuard({ profileId: 1, names: ["ANNA NOWAK"] });
  expect(guard.isPrivate("NOWAK ANNA")).toBe(true);
  expect(guard.mask("przelew dla Nowak Anna")).toBe("przelew dla [name]");
  expect(looksLikePerson("ANNA NOWAK UL. POLNA 5 WARSZAWA")).toBe(true);
  expect(looksLikePerson("JAN BAR")).toBe(true);
  expect(looksLikePerson("BAR MLECZNY POD ORLEM")).toBe(false);
});

describe("test_a_date_after_an_amount_stays_a_date_and_no_placeholder_leaks", () => {
  const months = Array.from(
    { length: 12 },
    (_, m) => `2025-${String(m + 1).padStart(2, "0")}-01`,
  ).join(" ");
  it.each([
    // the Polish price alert message (alerts/evaluate.py): the close date follows an amount
    [
      "IUSQ: zamknięcie 101,5 EUR (2026-10-01), powyżej 100 EUR.",
      "IUSQ: zamknięcie [amount] (2026-10-01), powyżej [amount].",
    ],
    ["Cena (2026-10-01) wynosi", "Cena (2026-10-01) wynosi"],
    [
      "IUSQ closed at 101.5 EUR on 2026-10-01, above 100 EUR.",
      "IUSQ closed at [amount] on 2026-10-01, above [amount].",
    ],
    // many protected dates (two-digit placeholder indexes) after a money word
    [`saldo 12 PLN ${months}`, `saldo [amount] ${months}`],
  ])("%s", (t, expected) => {
    const out = scrubText(t, { strict: true });
    expect(out).toBe(expected);
    expect(out).not.toContain("\u0000");
    expect(/[-]/u.test(out)).toBe(false);
    expect((STRICT.apply({ message: L.text(t) }) as { message: string }).message).toBe(expected);
  });
});

it("test_stray_nul_characters_never_reach_the_agent", () => {
  expect(scrubText("a\u0000b 2026-10-01", { strict: true })).toBe("a[date]b 2026-10-01");
});

// S37fix2 W1 / W2 (tests/test_mcp_s37fix.py): number words and slang amounts mask some ordinary
// words too; these over-masks are accepted (listed so a change is visible)
describe("test_number_words_mask_some_ordinary_words", () => {
  it.each([
    ["dwa koła roweru", "[amount] roweru"],
    ["jeden koło drugiego", "[amount] drugiego"],
    ["kilkutysięczny tłum", "[amount] tłum"],
    ["milioner", "[amount]"],
    ["multimillions", "[amount]"],
    ["setka na bieżni", "[amount] na bieżni"],
    ["tysiąclecie", "[amount]"],
  ])("%s", (text, masked) => {
    expect(scrubText(text, { strict: true })).toBe(masked);
  });
});
