/// <reference types="node" />
// Differential sweeps against Python (the retired Python privacy_vectors.py), exhaustive tier: every
// section replays the oracle's synthetic inputs through the TS port and expects the same output, byte
// for byte, in slices of SLICE rows (code points: one test per function and plane). The few small
// checks of the same vector files stay in privacy.vectors.test.ts.

import { pyCasefold } from "@cashu/domain";
import * as macro from "@cashu/domain/investments/macro";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type PropertySchema,
  ToolError,
  type ToolSpec,
  toolSpec,
  validateArguments,
} from "../registry.js";
import { scrubAmountLiterals } from "./exprLiterals.js";
import { amount, compactNumber, level, marketOk, pct, share } from "./labels.js";
import { scrubNumbers } from "./messages.js";
import {
  collectGuard,
  fold,
  looksLikePerson,
  NameGuard,
  nameTerms,
  normalize,
  personPart,
} from "./names.js";
import { pyDumps } from "./pyJson.js";
import { pyIsDigit } from "./pyText.js";
import { LeakDetected, leakCheck, Redactor, UnlabelledValue } from "./redactor.js";
import { identifierIn, isinValid, scrubText } from "./scrub.js";
import {
  BLOCKS_PER_PLANE,
  decodeTree,
  decodeValue,
  type EncodedTree,
  encodeValue,
  exprDepsFromVectors,
  guardsById,
  loadVectors,
  Mismatches,
  PLANES,
  planeHashes,
  slices,
  type Typed,
} from "./testing/vectors.js";
import { normalizeForMatching } from "./workText.js";

const GUARDS = guardsById();
const guard = (id: number | null) => (id === null ? null : (GUARDS.get(id) ?? null));
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

// Compile the scrub patterns and every guard's name patterns once (a one-time cost per process, about
// 1 s cold, which the MCP server pays once too), so each replay slice times the port itself.
beforeAll(() => {
  // a few rounds, so the regex engine's optimizing tier-up also happens here
  for (let round = 0; round < 10; round++) {
    for (const strict of [true, false]) {
      for (const text of WARM_UPS) {
        scrubText(text, { strict });
        for (const g of GUARDS.values()) scrubText(text, { strict, guard: g });
      }
    }
  }
});

/** Rows per replay test: each slice stays well under 100 ms of CPU. */
const SLICE = 300;

describe("Unicode classes and Python str behaviour", () => {
  const file = loadVectors<Record<string, string[]>>("classes");
  const bit = (re: RegExp) => (c: string) => (re.test(c) ? "1" : "0");
  const cases: [string, (c: string) => string][] = [
    ["w", bit(/^[\p{L}\p{N}_]$/u)],
    ["d", bit(/^\p{Nd}$/u)],
    ["isdigit", (c) => (pyIsDigit(c) ? "1" : "0")],
    ["casefold", pyCasefold],
    ["fold", fold],
    ["word_letters", bit(/^[\p{L}\p{Nl}\p{No}]$/u)],
  ];
  // One test per function and plane, so each stays small on a loaded machine.
  for (const [name, fn] of cases) {
    for (let plane = 0; plane < PLANES; plane++) {
      it(`${name} matches Python on every code point of plane ${plane}`, () => {
        const expected = (file[name] ?? []).slice(
          plane * BLOCKS_PER_PLANE,
          (plane + 1) * BLOCKS_PER_PLANE,
        );
        expect(planeHashes(fn, plane)).toEqual(expected);
      });
    }
  }
  it("covers every block", () => {
    for (const [name] of cases) expect(file[name]?.length, name).toBe(PLANES * BLOCKS_PER_PLANE);
  });
});

interface TextRow {
  text: string;
  guard: number | null;
  strict: string;
  amounts: string;
  isin: boolean;
  numbers: string;
  leak?: { sample: string; isins: string[]; leak: boolean };
}

describe("scrubText, isinValid, scrubNumbers, leakCheck (texts)", () => {
  const { rows } = loadVectors<{ rows: TextRow[] }>("texts");
  // One `it` per variant, so each gets its own timeout budget on a loaded machine.
  for (const strict of [true, false]) {
    const key = strict ? "strict" : "amounts";
    for (const [from, part] of slices(rows, SLICE)) {
      it(`replays synthetic texts ${from}-${from + part.length - 1} (scrubText ${key})`, () => {
        const m = new Mismatches();
        for (const [k, r] of part.entries()) {
          const i = from + k;
          m.check(`#${i} ${key}`, scrubText(r.text, { strict, guard: guard(r.guard) }), r[key]);
        }
        expect(m.items, m.report()).toEqual([]);
      });
    }
  }
  for (const [from, part] of slices(rows, SLICE)) {
    it(`replays synthetic texts (isinValid, scrubNumbers, leakCheck) ${from}-${from + part.length - 1}`, () => {
      const m = new Mismatches();
      for (const [k, r] of part.entries()) {
        const i = from + k;
        m.check(`#${i} isin`, isinValid(r.text), r.isin);
        m.check(`#${i} numbers`, scrubNumbers(r.text), r.numbers);
        if (r.leak) {
          let leaked = false;
          try {
            leakCheck({ note: r.leak.sample }, { strict: false, isins: new Set(r.leak.isins) });
          } catch (e) {
            if (!(e instanceof LeakDetected)) throw e;
            leaked = true;
          }
          m.check(`#${i} leak`, leaked, r.leak.leak);
        }
      }
      expect(m.items, m.report()).toEqual([]);
    });
  }
});

interface NameRow {
  guard: number;
  value: string;
  fold: string;
  normalize: string;
  person_part: string[];
  looks_like_person: boolean;
  terms: string[];
  terms_tokens: string[];
  is_private: boolean;
  payee_ref: string;
  merchant: string;
  mask_input: string;
  mask: string;
  public_input: string;
  public_name: string;
  swap_input: string;
  swap: string;
}

describe("names: fold, normalize, persons, terms, guard", () => {
  const { rows } = loadVectors<{ rows: NameRow[] }>("names");
  for (const [from, part] of slices(rows, SLICE)) {
    it(`replays names ${from}-${from + part.length - 1}`, () => {
      const m = new Mismatches();
      for (const [k, r] of part.entries()) {
        const i = from + k;
        const g = guard(r.guard);
        if (g === null) throw new Error("unknown guard");
        m.check(`#${i} fold`, fold(r.value), r.fold);
        m.check(`#${i} normalize`, normalize(r.value), r.normalize);
        m.check(`#${i} person_part`, personPart(r.value), r.person_part);
        m.check(`#${i} looks_like_person`, looksLikePerson(r.value), r.looks_like_person);
        m.check(`#${i} terms`, [...nameTerms(r.value, { tokens: false })].sort(), r.terms);
        m.check(
          `#${i} terms_tokens`,
          [...nameTerms(r.value, { tokens: true })].sort(),
          r.terms_tokens,
        );
        m.check(`#${i} is_private`, g.isPrivate(r.value), r.is_private);
        m.check(`#${i} payee_ref`, g.payeeRef(r.value), r.payee_ref);
        m.check(`#${i} merchant`, g.merchant(r.value), r.merchant);
        m.check(`#${i} mask`, g.mask(r.mask_input), r.mask);
        m.check(`#${i} public_name`, g.publicName(r.public_input), r.public_name);
        m.check(`#${i} swap`, g.swapAliases(r.swap_input), r.swap);
      }
      expect(m.items, m.report()).toEqual([]);
    });
  }

  const masks = loadVectors<{
    rows: {
      guard: number;
      text: string;
      mask: string;
      candidates: string[];
      resolve_ref: string | null;
      resolve_name: string | null;
      resolve_target: string;
    }[];
  }>("masks").rows;
  for (const [from, part] of slices(masks, SLICE)) {
    it(`replays masks and payee resolutions ${from}-${from + part.length - 1}`, () => {
      const m = new Mismatches();
      for (const [k, r] of part.entries()) {
        const i = from + k;
        const g = guard(r.guard);
        if (g === null) throw new Error("unknown guard");
        m.check(`#${i} mask`, g.mask(r.text), r.mask);
        m.check(
          `#${i} resolve ref`,
          g.resolve(g.payeeRef(r.resolve_target), r.candidates),
          r.resolve_ref,
        );
        m.check(
          `#${i} resolve name`,
          g.resolve(r.resolve_target.toLowerCase(), r.candidates),
          r.resolve_name,
        );
      }
      expect(m.items, m.report()).toEqual([]);
    });
  }
});

interface CollectRow {
  profile: string;
  accounts: (string | null)[];
  providers: {
    strong: string[];
    persons: string[];
    private: string[];
    aliases: [string, string][];
  }[];
  names: string[];
  payees: string[];
  aliases: [string, string][];
}

describe("collectGuard", () => {
  const { rows } = loadVectors<{ rows: CollectRow[] }>("collect");
  for (const [from, part] of slices(rows, SLICE)) {
    it(`replays provider sets ${from}-${from + part.length - 1}`, () => {
      const m = new Mismatches();
      for (const [k, r] of part.entries()) {
        const i = from + k;
        const g = collectGuard({
          profileId: 1,
          profileName: r.profile,
          accountNames: r.accounts,
          providers: r.providers.map((p) => ({
            strongNames: p.strong,
            persons: p.persons,
            privatePayees: p.private,
            strictAliases: p.aliases,
          })),
        });
        m.check(`#${i} names`, [...g.names].sort(), r.names);
        m.check(`#${i} payees`, [...g.privatePayees].sort(), r.payees);
        m.check(`#${i} aliases`, g.strictAliases, r.aliases);
      }
      expect(m.items, m.report()).toEqual([]);
    });
  }
});

interface LabelRow {
  v: Typed;
  digits: number;
  amount: Typed;
  pct: Typed;
  level: Typed;
  base: Typed;
  share: Typed | { error: string };
  compact?: { v: string; out: string };
}

describe("label helpers: rounding, share, compact numbers", () => {
  const { rows } = loadVectors<{ rows: LabelRow[] }>("labels");
  for (const [from, part] of slices(rows, SLICE)) {
    it(`replays numbers ${from}-${from + part.length - 1}`, () => {
      const m = new Mismatches();
      for (const [k, r] of part.entries()) {
        const i = from + k;
        const v = decodeValue(r.v) as number | bigint;
        m.check(`#${i} amount`, encodeValue(amount(v, r.digits).value), r.amount);
        m.check(`#${i} pct`, encodeValue(pct(v).value), r.pct);
        m.check(`#${i} level`, encodeValue(level(v).value), r.level);
        const base = decodeValue(r.base) as number | bigint | null;
        let got: unknown;
        try {
          got = encodeValue(share(v, base).value);
        } catch {
          got = { error: "InvalidOperation" };
        }
        m.check(`#${i} share`, got, r.share);
        if (r.compact) m.check(`#${i} compact`, compactNumber(Number(r.compact.v)), r.compact.out);
      }
      expect(m.items, m.report()).toEqual([]);
    });
  }
});

describe("market text", () => {
  const file = loadVectors<{
    vocabulary: string[];
    summary_max: number;
    rows: { text: string; market_ok: boolean; summary_ok: boolean }[];
  }>("market");
  const check = macro.summaryChecker(new Set(file.vocabulary), file.summary_max);
  for (const [from, part] of slices(file.rows, SLICE)) {
    it(`replays market texts ${from}-${from + part.length - 1}`, () => {
      const m = new Mismatches();
      for (const [k, r] of part.entries()) {
        const i = from + k;
        m.check(`#${i} market_ok`, marketOk(r.text, check), r.market_ok);
        m.check(`#${i} summary_ok`, check(r.text), r.summary_ok);
      }
      expect(m.items, m.report()).toEqual([]);
    });
  }
});

type TreeOutcome =
  | { out: string; isins: string[]; non_money: string[] }
  | { error: "leak"; isins: string[] }
  | { error: "unlabelled" };

describe("Redactor + leakCheck on random labelled trees", () => {
  const file = loadVectors<{
    rows: { guard: number | null; tree: EncodedTree; strict: TreeOutcome; amounts: TreeOutcome }[];
  }>("trees");
  const vocabulary = loadVectors<{ vocabulary: string[] }>("market").vocabulary;
  const summaryOk = macro.summaryChecker(new Set(vocabulary));
  // One `it` per privacy level and slice of rows, so each stays small on a loaded machine.
  for (const privacy of ["strict", "amounts"] as const) {
    for (const [from, part] of slices(file.rows, SLICE)) {
      it(`replays trees ${from}-${from + part.length - 1} in privacy level ${privacy}`, () => {
        const m = new Mismatches();
        for (const [k, r] of part.entries()) {
          const i = from + k;
          const redactor = new Redactor({ privacy, guard: guard(r.guard), summaryOk });
          let got: TreeOutcome;
          try {
            const data = redactor.apply(decodeTree(r.tree));
            try {
              leakCheck(data, {
                strict: redactor.strict,
                isins: redactor.isins,
                nonMoney: redactor.nonMoney,
              });
              got = {
                out: pyDumps(data),
                isins: [...redactor.isins].sort(),
                non_money: [...redactor.nonMoney].sort(),
              };
            } catch (e) {
              if (!(e instanceof LeakDetected)) throw e;
              got = { error: "leak", isins: [...redactor.isins].sort() };
            }
          } catch (e) {
            if (!(e instanceof UnlabelledValue)) throw e;
            got = { error: "unlabelled" };
          }
          m.check(`#${i} ${privacy}`, got, r[privacy]);
        }
        expect(m.items, m.report()).toEqual([]);
      });
    }
  }
});

describe("scrubAmountLiterals over the Python parser's trees", () => {
  const file = loadVectors<{
    rows: { source: string; scrubbed: string; scrubbed_private: string }[];
  }>("expressions");
  const deps = exprDepsFromVectors();
  for (const [from, part] of slices(file.rows, SLICE)) {
    it(`replays expressions ${from}-${from + part.length - 1}`, () => {
      const m = new Mismatches();
      for (const [k, r] of part.entries()) {
        const i = from + k;
        m.check(`#${i} scrub`, scrubAmountLiterals(r.source, deps), r.scrubbed);
        m.check(
          `#${i} private`,
          scrubAmountLiterals(r.source, deps, { privatePrices: true }),
          r.scrubbed_private,
        );
      }
      expect(m.items, m.report()).toEqual([]);
    });
  }
});

interface SpecJson {
  name: string;
  module: string;
  properties: [string, PropertySchema][];
  required: string[];
  refused: Record<string, string>;
  refused_values: Record<string, Record<string, string>>;
  nullable: string[];
  also: string[];
  input_schema: unknown;
  enabled: Record<string, boolean>;
  listed: Record<string, string>;
}

describe("registry: input schema, module gating, argument validation", () => {
  const file = loadVectors<{
    specs: SpecJson[];
    rows: {
      spec: string;
      args: Record<string, unknown>;
      ok?: Record<string, unknown>;
      error?: string;
      kind?: string;
    }[];
  }>("registry");
  const specs = new Map<string, ToolSpec<never>>(
    file.specs.map((s) => [
      s.name,
      toolSpec<never>({
        name: s.name,
        module: s.module,
        description: "",
        handler: () => ({}),
        properties: Object.fromEntries(s.properties),
        required: s.required,
        refused: s.refused,
        refusedValues: s.refused_values,
        nullable: s.nullable,
        also: s.also,
      }),
    ]),
  );
  for (const [from, part] of slices(file.rows, SLICE)) {
    it(`replays argument sets ${from}-${from + part.length - 1}`, () => {
      const m = new Mismatches();
      for (const [k, r] of part.entries()) {
        const i = from + k;
        const spec = specs.get(r.spec) as ToolSpec<never>;
        let got: unknown;
        try {
          got = { ok: validateArguments(spec, r.args) };
        } catch (e) {
          if (!(e instanceof ToolError)) throw e;
          got = { error: e.message, kind: e.kind };
        }
        const want = r.ok !== undefined ? { ok: r.ok } : { error: r.error, kind: r.kind };
        m.check(`#${i}`, sortKeys(got), sortKeys(want));
      }
      expect(m.items, m.report()).toEqual([]);
    });
  }
});

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

interface AdversarialRow {
  text: string;
  norm: string;
  raw_leak: boolean;
  mask: string;
  [key: string]: string | boolean;
}

describe("S37fix adversarial vectors (shared file + separator / inflection / number fuzz)", () => {
  const file = loadVectors<{
    guard_names: string[];
    money_keys: Record<string, boolean>;
    rows: AdversarialRow[];
  }>("adversarial");
  const g = new NameGuard({ profileId: 1, names: file.guard_names });
  const parts = slices(file.rows, SLICE);
  for (const [from, part] of parts) {
    it(`replays texts ${from}-${from + part.length - 1} byte for byte (normalize, identifierIn, mask)`, () => {
      const m = new Mismatches();
      for (const [k, r] of part.entries()) {
        const i = from + k;
        m.check(`#${i} norm`, normalizeForMatching(r.text), r.norm);
        m.check(`#${i} raw_leak`, identifierIn(r.text), r.raw_leak);
        m.check(`#${i} mask`, g.mask(r.text), r.mask);
      }
      expect(m.items, m.report()).toEqual([]);
    });
  }
  // One `it` per scrub variant and slice of rows, so each stays small on a loaded machine.
  for (const strict of [true, false]) {
    for (const guarded of [false, true]) {
      const key = (strict ? "strict" : "amounts") + (guarded ? "_guard" : "");
      for (const [from, part] of parts) {
        it(`replays texts ${from}-${from + part.length - 1} byte for byte (scrubText ${key})`, () => {
          const m = new Mismatches();
          for (const [k, r] of part.entries()) {
            const i = from + k;
            const out = scrubText(r.text, { strict, guard: guarded ? g : null });
            m.check(`#${i} ${key}`, out, r[key]);
            m.check(`#${i} ${key}_leak`, identifierIn(out), r[`${key}_leak`]);
          }
          expect(m.items, m.report()).toEqual([]);
        });
      }
    }
  }
});
