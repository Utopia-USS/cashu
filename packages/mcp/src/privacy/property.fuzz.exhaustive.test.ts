// Property search, exhaustive tier: on fuzzed synthetic labelled trees (5 seeds x 400 cases, in slices
// of SLICE cases), in both privacy modes, an answer that passes the redactor and the leak check never
// carries a planted IBAN, account number, card or phone number, a known person's name, an
// identifier-labelled value, or (strict) an amount-labelled value. A seeded PRNG keeps every run
// identical; a failure prints the seed and case.
import { beforeAll, describe, expect, it } from "vitest";
import * as L from "./labels.js";
import { collectGuard, fold } from "./names.js";
import { pyDumps } from "./pyJson.js";
import { LeakDetected, leakCheck, Redactor, UnlabelledValue } from "./redactor.js";

/** mulberry32: small, seeded, good enough for test inputs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = prng(seed);
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)] as T;
  }
  digits(n: number): string {
    let s = String(this.int(1, 9));
    while (s.length < n) s += String(this.int(0, 9));
    return s;
  }
}

const FIRST = ["Anna", "Zofia", "Grzegorz", "Łucja", "Ewelina", "Bartosz", "Mirosław"];
const LAST = [
  "Wiśniewska",
  "Kowalczyk",
  "Brzęczyszczykiewicz",
  "Dąbrowski",
  "Żurawska",
  "Sikorski",
];
// separators the identifier rules cover (at most two between digit groups)
const SEPS = ["", " ", "  ", " ", "-", "/", "_", " -"];
const DIGIT_SETS = ["0123456789", "٠١٢٣٤٥٦٧٨٩", "０１２３４５６７８９", "𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗"];
const FILLER = [
  "przelew",
  "dla",
  "rata",
  "kwota",
  "note",
  "z",
  "on",
  "2026-10-01",
  "12.5%",
  "row 3",
  "(",
  ")",
  ";",
  "\u2014x",
];

function mod97(numeric: string): number {
  let r = 0;
  for (const ch of numeric) r = (r * 10 + Number(ch)) % 97;
  return r;
}

function iban(g: Gen): string {
  const country = g.pick(["PL", "DE", "GB", "FR"]);
  const body = g.digits(g.pick([18, 20, 24]));
  const letters = Array.from(country, (c) => String(c.charCodeAt(0) - 55)).join("");
  const check = 98 - mod97(`${body}${letters}00`);
  return `${country}${String(check).padStart(2, "0")}${body}`;
}

function group(g: Gen, digits: string): string {
  const sep = g.pick(SEPS);
  const size = g.pick([2, 3, 4]);
  const parts: string[] = [];
  for (let i = 0; i < digits.length; i += size) parts.push(digits.slice(i, i + size));
  return parts.join(sep);
}

function localDigits(g: Gen, s: string): string {
  const set = Array.from(g.pick(DIGIT_SETS));
  return s.replace(/[0-9]/g, (d) => set[Number(d)] as string);
}

interface Planted {
  readonly secrets: string[]; // digit strings (ASCII) that must not survive
  readonly names: string[]; // folded full names that must not survive
  readonly idents: string[]; // identifier-labelled values
  readonly amounts: string[]; // amount-labelled reprs (strict only)
}

function secretText(g: Gen, planted: Planted, persons: readonly string[]): string {
  const kind = g.int(0, 6);
  if (kind === 0) {
    const v = iban(g);
    planted.secrets.push(v.slice(4));
    return g.next() < 0.5 ? v : `${v.slice(0, 4)}${g.pick(["", " "])}${group(g, v.slice(4))}`;
  }
  if (kind === 1) {
    const d = g.digits(g.int(10, 26));
    planted.secrets.push(d);
    return localDigits(g, group(g, d));
  }
  if (kind === 2) {
    const d = g.digits(16);
    planted.secrets.push(d);
    return d.match(/.{4}/g)?.join(".") ?? d; // dotted card / account number
  }
  if (kind === 3) {
    const d = g.digits(g.int(6, 9));
    planted.secrets.push(d);
    return `${g.pick(["U", "A", "XY"])}${d}`; // broker account id
  }
  if (kind === 4) {
    const d = g.digits(g.int(6, 9));
    planted.secrets.push(d);
    return `${g.pick(["konto", "Konto nr", "rachunek", "account", "nr"])} ${d}`;
  }
  const person = g.pick(persons);
  planted.names.push(fold(person));
  const shown = g.pick([
    person,
    person.toUpperCase(),
    fold(person),
    person.split(" ").reverse().join(" "),
  ]);
  return shown;
}

// Parts are kept apart by a word: two digit groups one space apart form one longer run (masked as one
// identifier since S37fix, see "closed gaps" below), which this contract does not need.
const WORD_GAPS = [" dla ", ", przelew ", " - z - ", "; note "];

function sentence(g: Gen, planted: Planted, persons: readonly string[]): string {
  const parts: string[] = [];
  for (let i = g.int(1, 4); i > 0; i--) {
    parts.push(g.next() < 0.6 ? secretText(g, planted, persons) : g.pick(FILLER));
  }
  return parts.join(g.pick(WORD_GAPS));
}

function leaf(g: Gen, planted: Planted, persons: readonly string[]): L.Labelled {
  const kind = g.int(0, 9);
  switch (kind) {
    case 0: {
      const v = `${sentence(g, planted, persons)} ID${g.digits(5)}`;
      planted.idents.push(v);
      return L.identifier(v);
    }
    case 1: {
      const v = Number(`${g.digits(7)}.${g.digits(2)}`);
      planted.amounts.push(String(v));
      return L.amount(v);
    }
    case 2:
      return L.merchant(g.next() < 0.5 ? g.pick(persons) : sentence(g, planted, persons));
    case 3:
      return L.symbol(g.next() < 0.5 ? sentence(g, planted, persons) : "CDR");
    case 4:
      return L.category(sentence(g, planted, persons));
    case 5:
      return L.account(sentence(g, planted, persons));
    case 6:
      return L.pct(g.next());
    case 7:
      return L.count(g.int(0, 99));
    default:
      return L.text(sentence(g, planted, persons));
  }
}

const KEYS = [
  "note",
  "message",
  "value",
  "total",
  "name",
  "payee",
  "items",
  "rows",
  "cash",
  "weight",
  "symbol",
];

function tree(g: Gen, planted: Planted, persons: readonly string[], depth = 0): L.LabelledTree {
  const roll = g.next();
  if (depth >= 3 || roll < 0.4) return leaf(g, planted, persons);
  if (roll < 0.75) {
    const out: Record<string, L.LabelledTree> = {};
    for (let i = g.int(1, 4); i > 0; i--) out[g.pick(KEYS)] = tree(g, planted, persons, depth + 1);
    return out;
  }
  return Array.from({ length: g.int(1, 3) }, () => tree(g, planted, persons, depth + 1));
}

/** Digits of every JSON string with the separators the identifier rules allow removed, as ASCII. */
function digitStream(json: string): string {
  return Array.from(json.replace(/[  ._/-]/gu, ""))
    .map((c) => {
      const cp = c.codePointAt(0) as number;
      for (const set of DIGIT_SETS) {
        const i = Array.from(set).indexOf(c);
        if (i >= 0) return String(i);
      }
      return cp < 0x80 ? c : "?";
    })
    .join("");
}

function wholeWord(haystack: string, needle: string): boolean {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`,
    "u",
  ).test(haystack);
}

const SEEDS = [1, 2, 3, 37, 2026];
const ITERATIONS = 400;

const SLICE = 50;
/**
 * Texts that reach every scrub pass (identifier, money, unit, word and name rules): one with Polish
 * letters and one in ASCII only, because V8 compiles each regex separately for one-byte and two-byte
 * strings, and one with the Unicode forms whose tables load lazily.
 */
const WARM_UPS = [
  "Przelew dla Anny Nowak 4532 0151 1283 0366, kwota 1 234,56 zł, 12,5 % i 10 dni, dwa tysiące, " +
    "nr1500, 2024-01-15, u1234567, a.b@example.com",
  "Przelew dla Anny Nowak 4532 0151 1283 0366, kwota 1 234,56 PLN, 12,5 % i 10 dni, dwa tysiace, " +
    "nr1500, 2024-01-15, u1234567, a.b@example.com",
  // non-Latin digits, compatibility forms and astral letters: their Unicode tables load on first use
  "\u0664\u0665\u0663\u0662 \uff11\uff12\uff13\uff14 \u{1d7ce}\u{1d7cf} \u0967\u0968 \ufb01 \u00bd \u1e9e \u03a9",
];

interface Case {
  readonly guard: ReturnType<typeof collectGuard>;
  readonly tree: L.LabelledTree;
  readonly planted: Planted;
}

/** The seed's cases in generation order (the generator's draws are the same as one long loop). */
function cases(seed: number): Case[] {
  const g = new Gen(seed);
  const out: Case[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const persons = [`${g.pick(FIRST)} ${g.pick(LAST)}`, `${g.pick(FIRST)} ${g.pick(LAST)}`];
    const guard = collectGuard({
      profileId: 1,
      profileName: null,
      accountNames: [],
      providers: [{ persons, privatePayees: persons }],
      secret: new Uint8Array(32).fill(7),
    });
    const planted: Planted = { secrets: [], names: [], idents: [], amounts: [] };
    out.push({ guard, tree: tree(g, planted, persons), planted });
  }
  return out;
}

describe("no identifier, account number, name or strict amount survives redaction", () => {
  for (const seed of SEEDS) {
    const all = cases(seed);
    const counts = { passed: 0, refused: 0 };
    // Compile the scrub and name patterns once (a one-time cost per process, about 1 s cold, which the
    // MCP server pays once too), so the slices below time the redaction itself.
    beforeAll(() => {
      for (const { guard } of all) for (const text of WARM_UPS) guard.mask(text);
      // a few rounds, so the regex engine's optimizing tier-up also happens here
      for (let round = 0; round < 10; round++) {
        for (const strict of [true, false]) {
          new Redactor({
            privacy: strict ? "strict" : "amounts",
            guard: all[0]?.guard ?? null,
          }).apply({ n: WARM_UPS.map((text) => L.text(text)) });
        }
      }
    });
    // One test per slice of cases, so each stays small on a loaded machine.
    for (let from = 0; from < all.length; from += SLICE) {
      it(`seed ${seed} cases ${from}-${Math.min(from + SLICE, all.length) - 1}`, () => {
        for (const [k, { guard, tree: t, planted }] of all.slice(from, from + SLICE).entries()) {
          const i = from + k;
          for (const privacy of ["strict", "amounts"] as const) {
            const redactor = new Redactor({ privacy, guard });
            let json: string;
            try {
              const out = redactor.apply(t);
              leakCheck(out, { strict: redactor.strict, isins: redactor.isins });
              json = pyDumps(out);
              counts.passed++;
            } catch (e) {
              if (!(e instanceof LeakDetected) && !(e instanceof UnlabelledValue)) throw e;
              counts.refused++; // withheld: nothing is sent
              continue;
            }
            const where = `seed ${seed} #${i} ${privacy}`;
            const digits = digitStream(json);
            for (const s of planted.secrets) {
              expect(digits.includes(s.slice(-8)), `${where}: account digits survived`).toBe(false);
            }
            const folded = fold(json);
            for (const n of planted.names)
              expect(wholeWord(folded, n), `${where}: a name survived`).toBe(false);
            for (const v of planted.idents)
              expect(json.includes(v), `${where}: an identifier survived`).toBe(false);
            if (privacy === "strict") {
              for (const a of planted.amounts)
                expect(json.includes(a), `${where}: an amount survived`).toBe(false);
            }
          }
        }
      });
    }
    it(`seed ${seed}: the fuzz exercises sent answers, not only refusals`, () => {
      expect(counts.passed + counts.refused).toBe(ITERATIONS * 2);
      expect(counts.passed).toBeGreaterThan(counts.refused);
    });
  }
});
