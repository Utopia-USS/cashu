// Property tests on fuzzed synthetic labelled trees: whatever the tree, in both privacy modes, an answer
// that passes the redactor and the leak check never carries a planted IBAN, account number, card or
// phone number, a known person's name, an identifier-labelled value, or (strict) an amount-labelled
// value. A seeded PRNG keeps every run identical; a failure prints the seed and iteration.
import { describe, expect, it } from "vitest";
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
  "—x",
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

// Parts are kept apart by a word: two digit groups one space apart form one longer run, and that
// interplay is a known gap of the Python rules (pinned in "known gaps" below), not this contract.
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

describe("no identifier, account number, name or strict amount survives redaction", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      const g = new Gen(seed);
      let passed = 0;
      let refused = 0;
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
        const t = tree(g, planted, persons);
        for (const privacy of ["strict", "amounts"] as const) {
          const redactor = new Redactor({ privacy, guard });
          let json: string;
          try {
            const out = redactor.apply(t);
            leakCheck(out, { strict: redactor.strict, isins: redactor.isins });
            json = pyDumps(out);
            passed++;
          } catch (e) {
            if (!(e instanceof LeakDetected) && !(e instanceof UnlabelledValue)) throw e;
            refused++; // withheld: nothing is sent
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
      expect(passed).toBeGreaterThan(refused); // the fuzz exercises sent answers, not only refusals
    });
  }
});

describe("known gaps (same output as Python; reported to the lead, not changed here)", () => {
  // A number one space before a dotted card / account number joins the long-digit rule first; the
  // dotted rule then sees only three groups and 12 digits leave, in both modes, and the leak check
  // (same patterns) lets them through. Python 3.14 gives exactly these strings.
  it.each([
    ["konto 1234567 7942.8841.3456.5750 dla", "konto [number].8841.3456.5750 dla"],
    ["XY12345678 8771.5052.4115.1224 12.5%", "XY[number].5052.4115.1224 12.5%"],
    ["U1234567 5846.8915.7764.4910 przelew", "U[number].8915.7764.4910 przelew"],
  ])("%s", (input, python) => {
    for (const strict of [true, false]) {
      const out = new Redactor({ privacy: strict ? "strict" : "amounts" }).apply({
        n: L.text(input),
      });
      expect((out as { n: string }).n).toBe(python);
      leakCheck(out, { strict });
    }
  });
});
