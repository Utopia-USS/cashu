// Adversarial privacy cases (S37fix, S37fix2, S37fix3 review findings): text the owner or the market
// wrote that tried to smuggle an identifier, an amount or a known person's name past the redactor.
// Each rule has a few hand-picked cases; every redacted answer must also pass the final leak check.
// Everything is invented: the Visa test card 4532 0151 1283 0366, the textbook IBAN
// PL61 1090 1014 0000 0712 1981 2874 and the names Anna Nowak / Jan Kowalski.
import { describe, expect, it } from "vitest";
import * as L from "./labels.js";
import { customCondition, customSignalMessage, scrubNumbers } from "./messages.js";
import { NameGuard } from "./names.js";
import { isMoneyKey, LeakDetected, leakCheck, Redactor, UnlabelledValue } from "./redactor.js";
import { scrubText } from "./scrub.js";

type Mode = "strict" | "amounts";
const BOTH: readonly Mode[] = ["strict", "amounts"];
const STRICT: readonly Mode[] = ["strict"];
const AMOUNTS: readonly Mode[] = ["amounts"];
const GUARD_NAMES = ["ANNA NOWAK", "JAN KOWALSKI"];
const GUARD = new NameGuard({ profileId: 1, names: GUARD_NAMES });

/** Texts whose listed substrings must not reach the agent. */
interface Hidden {
  readonly rule: string;
  readonly modes: readonly Mode[];
  readonly guard?: true;
  readonly cases: readonly (readonly [text: string, absent: readonly string[]])[];
}
/** Texts with the exact redacted result in the listed modes. */
interface Exact {
  readonly rule: string;
  readonly modes: readonly Mode[];
  readonly guard?: true;
  readonly cases: readonly (readonly [text: string, expected: string])[];
}

/** The text sent for `text` (redacted as owner text) in `mode`, after the final leak check. */
function sent(text: string, mode: Mode, guard: NameGuard | null): string {
  const redactor = new Redactor({ privacy: mode, guard });
  const out = redactor.apply({ note: L.text(text) });
  leakCheck(out, { strict: redactor.strict, isins: redactor.isins, nonMoney: redactor.nonMoney });
  return (out as { note: string }).note;
}

// F1: card and IBAN digit groups stay one identifier across any separator
const SEPARATORS = [
  " ", // thin space
  " ", // narrow no-break space
  " ", // figure space
  " ", // em space
  "　", // ideographic space
  "​", // zero width space
  "\t",
  "\n",
  "–", // en dash
  ",",
  "   ",
  " - ",
  " ", // no-break space
  "­", // soft hyphen
  "⁠", // word joiner
  "−", // minus sign
  "/",
  "_",
  ".",
];

const HIDDEN: readonly Hidden[] = [
  {
    rule: "F1 card / IBAN digit groups joined by other separators",
    modes: BOTH,
    cases: [
      ["karta 4532.0151 1283.0366", ["0151", "1283", "0366"]],
      ["karta 4532 0151.1283.0366", ["0151", "1283", "0366"]],
      ["PL61,1090,1014,0000,0712,1981,2874", ["1090", "1014", "0000", "0712", "1981", "2874"]],
      ["61,1090,1014,0000,0712,1981,2874", ["1090", "1014", "0000", "0712", "1981", "2874"]],
      ["4532,0151,1283,0366", ["0151", "1283", "0366"]],
    ],
  },
  {
    rule: "F2 an amount before punctuation (strict)",
    modes: STRICT,
    cases: [
      ["Przelalem 5000.", ["5000"]],
      ["Rower 1234,-", ["1234"]],
      ["za 1999.", ["1999"]],
    ],
  },
  {
    rule: "F3 a bare number that looks like a year is an amount (strict)",
    modes: STRICT,
    cases: [
      ["Kupilem za 2000 rower", ["2000"]],
      ["do 2000", ["2000"]],
      ["1999", ["1999"]],
    ],
  },
  {
    rule: "F4 grouped thousands (strict)",
    modes: STRICT,
    cases: [
      ["5\u2009000", ["5\u2009000", "000"]],
      ["12\u2009345,67", ["345", "67"]],
      ["1.234,56", ["234", "56"]],
    ],
  },
  {
    rule: "F5 inflected, reordered, split or homoglyph names",
    modes: BOTH,
    guard: true,
    cases: [
      ["przelew dla Anny Nowak", ["Anny", "Nowak", "owak"]],
      ["Annie Nowak", ["Annie", "Nowak", "owak"]],
      ["NOWAKOWA ANNA", ["NOWAKOWA", "NOWAK"]],
      ["Anna_Nowak", ["Nowak", "owak"]],
      ["An\u00adna Nowak", ["Nowak", "owak"]],
      ["Anna\u200bNowak", ["Nowak", "owak"]],
      ["A. Nowak", ["Nowak", "owak"]],
      ["ANNA NOWAK-KOWALSKA", ["NOWAK", "KOWALSKA"]],
      ["\u0410nna Nowak", ["Nowak", "owak"]], // Cyrillic A
      ["Janowi Kowalskiemu", ["Janowi", "Kowalskiemu", "Kowalski"]],
      ["Kowalski Jan", ["Kowalski"]],
      ["J. Kowalski", ["Kowalski"]],
      ["Anna \u039dowak", ["owak"]], // Greek N
    ],
  },
  {
    rule: "F6 digits smuggled after a timestamp",
    modes: BOTH,
    cases: [
      ["Termin 2024-01-15T00:00:00.4532015112830366", ["4532015112830366", "45320151", "12830366"]],
    ],
  },
  {
    rule: "F7 small amounts and counts in owner text (strict)",
    modes: STRICT,
    cases: [
      ["Zwrot 950 od Ewy", ["950"]],
      ["Rata 12 z 36", ["12", "36"]],
    ],
  },
  {
    rule: "F10 phones, broker ids, masked cards, obfuscated e-mails, PESEL, NIP",
    modes: BOTH,
    cases: [
      ["tel 600123456", ["600123456"]],
      ["tel 600 123 456", ["123 456", "456"]],
      ["tel +48 600-123-456", ["123", "456"]],
      ["u1234567", ["1234567"]],
      ["453201******0366", ["453201", "0366"]],
      ["karta **** 1234", ["1234"]],
      ["acc 12345678", ["12345678"]],
      ["jan.kowalski(at)example.com", ["kowalski", "example"]],
      ["nr dowodu ABC123456", ["123456"]],
      ["PESEL 85010112345", ["85010112345"]],
      ["NIP 526-000-12-46", ["000", "46"]],
    ],
  },
  {
    rule: "N9 a number glued to a word (strict)",
    modes: STRICT,
    cases: [
      ["kwota950", ["950"]],
      ["PLN950", ["950"]],
      ["zł950", ["950"]],
      ["wplata2500zl", ["2500"]],
    ],
  },
  {
    rule: "N9 a number glued to a word (strict)",
    modes: BOTH,
    cases: [["nr12345678", ["12345678"]]],
  },
  {
    rule: "N10 grouped thousands before a non-money unit (strict)",
    modes: STRICT,
    cases: [
      ["3 000 %", ["000"]],
      ["2_000 x", ["000"]],
      ["5•0000", ["0000"]],
      ["kwota 1 000 000", ["000"]],
    ],
  },
  {
    rule: "N11 names glued together or with a sharp s",
    modes: BOTH,
    guard: true,
    cases: [
      ["ANNANOWAK", ["ANNA", "anna", "Anna", "NOWAK", "nowak", "Nowak", "KOWALSKI", "Kowal"]],
      ["JANKOWALSKIEGO", ["ANNA", "anna", "Anna", "NOWAK", "nowak", "Nowak", "KOWALSKI", "Kowal"]],
      ["AnnaNowak123", ["ANNA", "anna", "Anna", "NOWAK", "nowak", "Nowak", "KOWALSKI", "Kowal"]],
      ["Jan Kowalßki", ["ANNA", "anna", "Anna", "NOWAK", "nowak", "Nowak", "KOWALSKI", "Kowal"]],
      [
        "przelewannanowak",
        ["ANNA", "anna", "Anna", "NOWAK", "nowak", "Nowak", "KOWALSKI", "Kowal"],
      ],
    ],
  },
  {
    rule: "words: amounts in words (strict)",
    modes: STRICT,
    cases: [
      ["dwa tysiące", ["dwa", "tysi"]],
      ["pół miliona", ["miliona"]],
      ["fifty dollars", ["fifty"]],
      ["sto dwadzieścia", ["sto", "dwadzie"]],
      ["one hundred and twenty", ["hundred", "twenty"]],
    ],
  },
  {
    rule: "N1 thousands separators before a non-money unit (strict)",
    modes: STRICT,
    cases: [
      ["Rata 1.250 x 360 miesięcy", ["1.250"]],
      ["kwota 250,000 dni", ["250"]],
      ["1.000 %", ["1.000"]],
      ["Wpłata 2,500 x 12", ["2,500", "12"]],
      ["1 250 x", ["250"]],
    ],
  },
  {
    rule: "N2 a year-like amount after a month name (strict)",
    modes: STRICT,
    cases: [
      ["w maju 2000 zł", ["2000"]],
      ["dec 2050 USD", ["2050"]],
      ["stycznia 2024", ["2024"]],
    ],
  },
  {
    rule: "N3 several amounts in one sentence (strict)",
    modes: STRICT,
    cases: [
      ["Mam 52 000 zł, rata 2 500 zł", ["52", "000", "2 500", "500"]],
      ["sprzedaj, gdy saldo spadnie poniżej 52 000 zł", ["52", "000"]],
    ],
  },
  {
    rule: "N4 digit groups split by punctuation or brackets",
    modes: BOTH,
    cases: [
      ["4532, 0151, 1283, 0366", ["0151", "1283", "0366"]],
      ["4532'0151'1283'0366", ["0151", "1283", "0366"]],
      ["4532|0151|1283|0366", ["0151", "1283", "0366"]],
      ["4532:0151:1283:0366", ["0151", "1283", "0366"]],
      ["4532 ; 0151 ; 1283 ; 0366", ["0151", "1283", "0366"]],
      ["4532 (0151) 1283 0366", ["0151", "1283", "0366"]],
      [
        "PL61    1090    1014    0000    0712    1981    2874",
        ["1090", "1014", "0000", "0712", "1981", "2874"],
      ],
      ["tel +48 (22) 123 45 67", ["123 45 67", "45 67", "(22)"]],
      ["tel (600) 123 456", ["123 456", "600"]],
    ],
  },
  {
    rule: "N5 a currency word away from the number (strict)",
    modes: STRICT,
    cases: [
      ["zł 500 dni", ["500"]],
      ["999 x PLN", ["999"]],
      ["€ 50 dni", ["50"]],
      ["50 % zł", ["50"]],
      ["line 12 PLN", ["12"]],
    ],
  },
  {
    rule: "N6 date-like digit groups that are not dates",
    modes: BOTH,
    cases: [
      ["1234-56-78 9012 3456", ["1234", "9012", "3456"]],
      ["PL61 1090-10-14 0000 0712 1981 2874", ["1090", "0712", "2874"]],
      ["2024-13-45 1234", ["2024", "1234"]],
    ],
  },
  {
    rule: "N8 names with no space or a zero-width joiner",
    modes: BOTH,
    guard: true,
    cases: [
      ["A.Nowak", ["Nowak", "Kowalski", "An\u200dna"]],
      ["AnnaNowak", ["Nowak", "Kowalski", "An\u200dna"]],
      ["An\u200dna Nowak", ["Nowak", "Kowalski", "An\u200dna"]],
      ["ANowak", ["Nowak", "Kowalski", "An\u200dna"]],
      ["przelewAnnaNowak", ["Nowak", "Kowalski", "An\u200dna"]],
      ["J.Kowalski", ["Nowak", "Kowalski", "An\u200dna"]],
    ],
  },
  {
    rule: "W1 a digit before a scale word (strict)",
    modes: STRICT,
    cases: [
      ["2 tysiące", ["2"]],
      ["7 miliardów", ["7"]],
      ["1,5 mln", ["1,5", "5"]],
      ["2 500 tysięcy", ["2", "500"]],
      ["Mam 4  tysiące", ["4"]],
    ],
  },
  {
    rule: "W3 a number glued in front of a link (strict)",
    modes: STRICT,
    cases: [
      ["xhttps://y/a950", ["950"]],
      ["kwotahttps://y/a77", ["77"]],
    ],
  },
  {
    rule: "W4 Unicode digit group separators (strict)",
    modes: STRICT,
    cases: [
      ["1・000", ["000"]],
      ["1٬000 zł", ["000"]],
      ["1\u2009000", ["000"]],
      ["2’000", ["000"]],
      ["3ʼ500", ["500"]],
      ["Wpłata 1٬500", ["500"]],
    ],
  },
];

const EXACT: readonly Exact[] = [
  {
    rule: "lead: a number one space before a dotted card is one identifier",
    modes: BOTH,
    cases: [
      ["konto 1234567 7942.8841.3456.5750 dla", "konto [number] dla"],
      ["XY12345678 8771.5052.4115.1224 12.5%", "[iban]%"], // one run from the country-code-like XY
      ["U1234567 5846.8915.7764.4910 przelew", "U[number] przelew"],
    ],
  },
  {
    rule: "keep: dates, periods, percentages, hashes and store numbers",
    modes: BOTH,
    guard: true,
    cases: [
      ["2024-01-15", "2024-01-15"],
      ["15.01.2024", "15.01.2024"],
      ["2026-Q3", "2026-Q3"],
      ["09/2026", "09/2026"],
      ["5%", "5%"],
      ["raport za Q3", "raport za Q3"],
      ["2024-01-15T10:00:00.123456+00:00", "2024-01-15T10:00:00.123456+00:00"],
      ["hash 3fa9c2e81b07d4", "hash 3fa9c2e81b07d4"],
      ["BIEDRONKA 7", "BIEDRONKA 7"],
      ["nowa kanapa i nowe auto", "nowa kanapa i nowe auto"],
    ],
  },
  {
    rule: "keep: dates, periods, percentages, hashes and store numbers",
    modes: AMOUNTS,
    guard: true,
    cases: [
      ["stycznia 2024", "stycznia 2024"],
      ["March 2026", "March 2026"],
      ["0.5", "0.5"],
      ["WIG20 i Q3", "WIG20 i Q3"],
      ["1 234 567,89 zl", "1 234 567,89 zl"],
      ["Saldo 12 345,67 PLN", "Saldo 12 345,67 PLN"],
    ],
  },
  {
    rule: "keep: ordinary words that are also number words (strict)",
    modes: STRICT,
    cases: [
      ["https://example.org/p11/world-robotics", "https://example.org/p11/world-robotics"],
      ["dwa koty", "dwa koty"],
      ["ten dom", "ten dom"],
      ["one of them", "one of them"],
      ["trzy razy", "trzy razy"],
    ],
  },
  {
    rule: "R1/R2 percentages, points, durations, units and file positions stay (strict)",
    modes: STRICT,
    cases: [
      ["37.3% portfela, dryf 2.5 pp", "37.3% portfela, dryf 2.5 pp"],
      ["12,5 p.p. i 3 pkt proc.", "12,5 p.p. i 3 pkt proc."],
      ["wzrost o 5 % w 12 miesięcy", "wzrost o 5 % w 12 miesięcy"],
      ["brak wpłat od 45 dni", "brak wpłat od 45 dni"],
      ["max 400 characters", "max 400 characters"],
      ["3x szybciej", "3x szybciej"],
      ["horyzont 10 lat", "horyzont 10 lat"],
      ["rule rebalance_check, row 12", "rule rebalance_check, row 12"],
      ["wiersz 7: brak daty", "wiersz 7: brak daty"],
      ["cash_weight > 10%", "cash_weight > 10%"],
      ["12 positions", "12 positions"],
    ],
  },
  {
    rule: "R1/R2 an amount cannot ride on a unit or a currency (strict)",
    modes: STRICT,
    cases: [
      ["5000 zł", "[amount]"],
      ["5 000 dni zaległości kwota 5000", "[amount] dni zaległości kwota [amount]"],
      ["5000%", "[amount]%"],
      ["kwota 5000%", "kwota [amount]%"],
      ["1500 dni", "[amount] dni"],
      ["5 000 x", "[amount] x"],
      ["row 1500", "row [amount]"],
      ["PLN 50 %", "[amount] %"],
      ["USD 50%", "[amount]%"],
      ["$ 75 %", "[amount] %"],
      ["saldo 120 dni temu 4500", "saldo 120 dni temu [amount]"],
      ["1 2 3 4 5 6 7 8 9 dni", "[number] dni"],
      ["zwrot 950", "zwrot [amount]"],
    ],
  },
  {
    rule: "R6 a percent cap of 99 stays next to a masked amount (strict)",
    modes: STRICT,
    cases: [
      ["cash_value > 5000 and cash_weight < 99%", "cash_value > [amount] and cash_weight < 99%"],
    ],
  },
  {
    rule: "W1 a number word before a scale word, any separator (strict)",
    modes: STRICT,
    cases: [
      ["dwa  tysiące", "[amount]"],
      ["dwa - tysiące", "[amount]"],
      ["dwa\u00adtysiące", "[amount]"],
      ["2 i pół miliona", "[amount]"],
      ["dwatysiące", "[amount]"],
    ],
  },
  {
    rule: "W2 slang and abbreviated amounts (strict)",
    modes: STRICT,
    cases: [
      ["dwa tys", "[amount]"],
      ["2 tyś", "[amount]"],
      ["5k", "[amount]"],
      ["2,5k", "[amount]"],
      ["półtora tysiąca", "[amount]"],
      ["kilka tysięcy", "[amount]"],
      ["kilkaset", "[amount]"],
      ["kilkanaście", "[amount]"],
      ["stówa", "[amount]"],
      ["dwie stówki", "[amount]"],
      ["dwa koła", "[amount]"],
      ["dwie bańki", "[amount]"],
      ["3 patyki", "[amount]"],
      ["tysiak", "[amount]"],
    ],
  },
  {
    rule: "W2 / W3 / S37fix3 ordinary words and links that stay (strict)",
    modes: STRICT,
    cases: [
      ["https://x.pl/a950b", "https://x.pl/a950b"],
      ["(https://x.pl/a95)", "(https://x.pl/a95)"],
      ["„www.x.pl/a95”", "„www.x.pl/a95”"],
      ["bańka spekulacyjna", "bańka spekulacyjna"],
      ["koło domu", "koło domu"],
      ["dwa banki", "dwa banki"],
      ["stow away", "stow away"],
      ["millionaire", "millionaire"],
      ["grand prix", "grand prix"],
      ["jednak", "jednak"],
      ["https://x.pl/a950", "https://x.pl/a950"],
      ["dwa do zera", "dwa do zera"],
      ["2-3 dni", "2-3 dni"],
      ["2 x 3 dni", "2 x 3 dni"],
    ],
  },
  {
    rule: "S37fix3 WL1 a number glued to a scale word (strict)",
    modes: STRICT,
    cases: [
      ["dwatys", "[amount]"],
      ["pięćmln", "[amount]"],
      ["2koła", "[amount]"],
      ["2 grand", "[amount]"],
      ["pożyczyłem mu dwatys. na auto", "pożyczyłem mu [amount] na auto"],
    ],
  },
  {
    rule: "S37fix3 WL2 ranges of amounts (strict)",
    modes: STRICT,
    cases: [
      ["2-3 tys.", "[amount]"],
      ["2 - 3 tys. zł", "[amount] zł"],
      ["2/3 tysiąca", "[amount]"],
      ["2,5-3 mln zł", "[amount] zł"],
      ["dwa lub trzy tysiące", "[amount]"],
      ["od dwóch do trzech tysięcy", "od [amount]"],
      ["two or three thousand", "[amount]"],
    ],
  },
  {
    rule: "S37fix3 WL3 digits inside a link path or query (strict)",
    modes: STRICT,
    cases: [
      ["zob. https://x.pl/a4532b", "zob. https://x.pl/a[amount]b"],
      ["(https://x.pl/saldo52000)", "(https://x.pl/[account])"],
      ["https://x.pl/a950?k=b1234", "https://x.pl/a950?k=b[amount]"],
    ],
  },
  {
    rule: "S37fix3 chained e-mail addresses",
    modes: BOTH,
    cases: [
      ["a.nowak@example.pl+jan@example.pl", "[email]"],
      ["anna@example.pl.jan@example.pl", "[email]@example.pl"],
    ],
  },
  {
    rule: "S37fix3 re-check: scale words after x or to, exponents (strict)",
    modes: STRICT,
    cases: [
      ["2 to 3 thousand", "[amount]"],
      ["2 x tysiąc", "[amount]"],
      ["wzrost 1e4% w rok", "wzrost [amount]% w rok"],
    ],
  },
];

describe("F1 card and IBAN digit groups across any separator", () => {
  it.each(SEPARATORS.map((s) => [JSON.stringify(s), s] as const))("%s", (_name, s) => {
    const card = `karta 4532${s}0151${s}1283${s}0366`;
    const iban = `przelew z PL61${s}1090${s}1014${s}0000${s}0712${s}1981${s}2874 dla`;
    for (const mode of BOTH) {
      const outCard = sent(card, mode, null);
      for (const group of ["0151", "1283", "0366"]) expect(outCard, mode).not.toContain(group);
      const outIban = sent(iban, mode, null);
      for (const group of ["1090", "1014", "0712", "1981", "2874"])
        expect(outIban, mode).not.toContain(group);
    }
  });
});

describe("hidden secrets", () => {
  it.each(HIDDEN.map((h) => [`${h.rule} (${h.modes.join(", ")})`, h] as const))("%s", (_id, h) => {
    for (const [text, absent] of h.cases)
      for (const mode of h.modes) {
        const out = sent(text, mode, h.guard ? GUARD : null);
        for (const secret of absent) expect(out, `${mode}: ${text}`).not.toContain(secret);
      }
  });
});

describe("exact redaction", () => {
  it.each(EXACT.map((e) => [`${e.rule} (${e.modes.join(", ")})`, e] as const))("%s", (_id, e) => {
    for (const [text, expected] of e.cases)
      for (const mode of e.modes)
        expect(sent(text, mode, e.guard ? GUARD : null), `${mode}: ${text}`).toBe(expected);
  });
});

it("keeps the original text outside the masked spans", () => {
  const thin = String.fromCodePoint(0x2009);
  const nbsp = String.fromCodePoint(0xa0);
  const card = ["4532", "0151", "1283", "0366"].join(thin);
  const text = `Za${thin}obiad${nbsp}- karta ${card},\tdzięki!`;
  expect(scrubText(text, { strict: false })).toBe(
    `Za${thin}obiad${nbsp}- karta [number],\tdzięki!`,
  );
});

describe("date label (F6)", () => {
  it.each([
    "2024-01-15T00:00:00.4532015112830366",
    "2024-01-15 4532 0151 1283 0366",
    "2024-01-15T0:0:0+4532015112830366",
  ])("refuses digits smuggled into %s", (value) => {
    for (const privacy of BOTH)
      expect(() => new Redactor({ privacy }).apply({ at: L.date(value) })).toThrow(UnlabelledValue);
  });
  it.each([
    "2024-01-15",
    "2024-01",
    "2024-01-15T10:00:00+00:00",
    "2024-01-15T10:00:00.123456+00:00",
    "2024-01-15 10:00:00Z",
  ])("keeps %s", (value) => {
    expect(new Redactor({ privacy: "strict" }).apply({ at: L.date(value) })).toEqual({ at: value });
  });
});

describe("leak check (F9, N7: money keys in strict; F1, F6, F10: identifiers in any mode)", () => {
  const MONEY_KEYS = [
    "value_share",
    "account_balance",
    "accounts_value",
    "generated_income",
    "corporate_cash",
    "value_change",
    "balance_index",
    "cash_vs_target",
    "net_worth",
    "spend_total",
    "deposits",
    "withdrawals",
    "proceeds",
    "pnl",
    "profit_ytd",
    "gain",
    "savings",
    "debt",
    "loan_left",
    "salary",
    "capital",
    "equity",
    "budget",
    "limit_pln",
    "x_eur",
    "rata_kredytu",
    "platnosc",
    "przychod",
    "suma",
    "value_base",
    "total_amount",
    "cash_value",
    "saldo_koncowe",
    "Kwota",
  ];
  it("refuses a number under a money key in strict", () => {
    for (const key of MONEY_KEYS)
      expect(() => leakCheck({ [key]: 100n }, { strict: true }), key).toThrow(LeakDetected);
    expect(() => leakCheck({ x: { amount_pln: 1234.5 } }, { strict: true })).toThrow(LeakDetected);
    leakCheck({ x: { amount_pln: 1234.5 } }, { strict: false });
    leakCheck({ weight: 0.1, share: 0.01, count: 3n }, { strict: true });
  });
  it("classifies money keys", () => {
    const money: Record<string, boolean> = {
      Kwota: true,
      amount_pln: true,
      balances: true,
      "cash-weight": true,
      expense_vs_average: true,
      fees_share: true,
      invalid_value: true,
      last_value: false,
      monthly_sum: true,
      net: true,
      network: false,
      "saldo koncowe": true,
      summary_max: false,
      value_base: true,
    };
    for (const [key, expected] of Object.entries(money))
      expect(isMoneyKey(key), key).toBe(expected);
  });
  it.each([
    "PL61,1090,1014,0000,0712,1981,2874",
    "karta 4532 0151 1283 0366",
    "konto 1234567 7942.8841.3456.5750",
    "453201******0366",
    "id u1234567",
  ])("refuses identifier text in any mode: %s", (note) => {
    expect(() => leakCheck({ note }, { strict: false })).toThrow(LeakDetected);
  });
  it("refuses a timestamp with smuggled digits and a ten-digit integer, keeps a real timestamp", () => {
    expect(() =>
      leakCheck({ at: "2024-01-15T00:00:00.4532015112830366" }, { strict: false }),
    ).toThrow(LeakDetected);
    expect(() => leakCheck({ n: 1234567890n }, { strict: false })).toThrow(LeakDetected);
    leakCheck(
      { at: "2024-01-15T10:00:00.123456+00:00", n: 123456789n, f: 1234567.89 },
      { strict: false },
    );
  });
});

describe("authored text (S37fix R3: cashU's own constant text keeps its numbers)", () => {
  it.each([
    [
      "P/E 15, wzrost 12% r/r, cel 5000 zł w 2027",
      { strict: "P/E 15, wzrost 12% r/r, cel 5000 zł w 2027" },
      "P/E [amount], wzrost 12% r/r, cel [amount] w [amount]",
    ],
    [
      "Anna Nowak, konto 4532 0151 1283 0366, 50 tys.",
      { strict: "[name], konto [number] tys.", amounts: "[name], konto [number] tys." },
      null,
    ],
    [
      "stale = not verified for 180 days (1 = 100%), python3.14",
      { strict: "stale = not verified for 180 days (1 = 100%), python3.14" },
      null,
    ],
  ] as const)("%s", (text, expect_, ownerStrict) => {
    for (const [mode, expected] of Object.entries(expect_)) {
      const redactor = new Redactor({ privacy: mode, guard: GUARD });
      const out = redactor.apply({ f: L.fixedText(text) });
      expect(out).toEqual({ f: expected });
      leakCheck(out, { strict: redactor.strict, isins: redactor.isins });
    }
    // the same text written by the owner is scrubbed as owner text
    if (ownerStrict !== null)
      expect(new Redactor({ privacy: "strict", guard: GUARD }).apply({ t: L.text(text) })).toEqual({
        t: ownerStrict,
      });
  });
});

it("keeps known digit-only symbols and masks unknown ones in strict (S37fix R5)", () => {
  const guard = new NameGuard({ profileId: 1, names: GUARD_NAMES, symbols: ["0700", "600519"] });
  const cases: [string, string, string][] = [
    ["0700", "0700", "0700"],
    ["600519", "600519", "600519"],
    ["0701", "[amount]", "0701"],
    ["123456", "[amount]", "123456"],
  ];
  for (const [symbol, strict, amounts] of cases) {
    expect(new Redactor({ privacy: "strict", guard }).apply({ s: L.symbol(symbol) })).toEqual({
      s: strict,
    });
    expect(new Redactor({ privacy: "amounts", guard }).apply({ s: L.symbol(symbol) })).toEqual({
      s: amounts,
    });
  }
});

describe("strict custom conditions (S37fix3 E1 / E2 / E4)", () => {
  it.each([
    ["cash_value < 80000%", ["80000"], "cash_value < [amount]"],
    ["weight * 12000000% > 900", ["12000000", "900"], "weight * [amount] > [amount]"],
    ["cash_value > 1000% and weight < 999%", ["1000"], "cash_value > [amount] and weight < 999%"],
    // does not parse: the fallback keeps small percentages only
    ["cash_value < 0080000% or broken (", ["80000"], "cash_value < [amount]% or broken ("],
    ["cash_value < 800k", ["800"], "cash_value < [amount]k"],
    ["cash_value < 800PLN", ["800"], "cash_value < [amount]PLN"],
    ["cash_value < 800_000", ["800", "000"], "cash_value < [amount]"],
    [
      'holding_has_tag("buffer 800") and weight < 0.5',
      ["800"],
      'holding_has_tag("buffer [amount]") and weight < 0.5',
    ],
    ["symbol == 'PL61109010140000071219812874'", ["1090", "2874"], "symbol == '[iban]'"],
    [
      'tagged_weight("4532 0151 1283 0366") > 10%',
      ["0151", "0366"],
      'tagged_weight("[number]") > 10%',
    ],
    ["cash_weight > 10%", [], "cash_weight > 10%"],
    [
      "weight < 12.5% and drawdown_from_high(252) >= 20%",
      [],
      "weight < 12.5% and drawdown_from_high(252) >= 20%",
    ],
    ["cash_value < 1e4%", ["1e4"], "cash_value < [amount]%"],
    ["weight < 1_000%", ["1_000", "000%"], "weight < [amount]%"],
  ] as const)("%s", (source, absent, expected) => {
    expect(customCondition({ strict: true }, source).value).toBe(expected);
    const out = new Redactor({ privacy: "strict", guard: GUARD }).apply({
      expression: customCondition({ strict: true }, source),
    }) as { expression: string };
    for (const secret of absent) expect(out.expression).not.toContain(secret);
  });

  it("scrubs the text literals of the condition inside a custom signal message", () => {
    const when = 'holding_has_tag("buffer 800") and weight < 0.5';
    const message = `bufor: Warunek spełniony: ${when} (cash_value 7 312,00 zł).`;
    const out = customSignalMessage({ strict: true }, message, when).value as string;
    expect(out).not.toContain("800");
    expect(out).not.toContain("7 312");
    expect(out).toContain('holding_has_tag("buffer [amount]") and weight < 0.5');
  });
});

describe("strict system messages (S37fix3 E2)", () => {
  it.each([
    ['Invalid number "800k..." (column 14)', 'Invalid number "#" (column 14)'],
    [
      'Names cannot start with "_" (got "_800000") (column 3)',
      'Names cannot start with "_" (got "#") (column 3)',
    ],
    [
      'cash_value is never "buffer 800"; did you mean "bufor 800"?',
      'cash_value is never "#"; did you mean "#"?',
    ],
    ["gap 800k and 800_000 and 1500% and kwota950", "gap #k and #_# and #% and kwota#"],
    [
      "IS3N drift 5 pp, 37.3% on 2026-03-02 at rules[3] line 12 column 4",
      "IS3N drift 5 pp, 37.3% on 2026-03-02 at rules[3] line 12 column 4",
    ],
    ["got 1e4% and 2E-3", "got #% and #"],
  ])("%s", (text, expected) => {
    expect(scrubNumbers(text)).toBe(expected);
  });
});
