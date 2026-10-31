/// <reference types="node" />
// Differential tests against Python (packages/mcp/test/privacy_vectors.py): every section replays
// the oracle's synthetic inputs through the TS port and expects the same output, byte for byte.

import { createHash } from "node:crypto";
import { pyCasefold } from "@cashu/domain";
import { macro } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import {
  enabledIn,
  inputSchema,
  listedModule,
  type PropertySchema,
  ToolError,
  type ToolSpec,
  toolSpec,
  validateArguments,
} from "../registry.js";
import { scrubAmountLiterals } from "./exprLiterals.js";
import { amount, compactNumber, level, marketOk, pct, share } from "./labels.js";
import { scrubNumbers } from "./messages.js";
import { collectGuard, fold, looksLikePerson, nameTerms, normalize, personPart } from "./names.js";
import { pyDumps } from "./pyJson.js";
import { pyIsDigit } from "./pyText.js";
import { LeakDetected, leakCheck, Redactor, UnlabelledValue } from "./redactor.js";
import { isinValid, scrubText } from "./scrub.js";
import {
  decodeTree,
  decodeValue,
  type EncodedTree,
  encodeValue,
  exprDepsFromVectors,
  guardsById,
  loadVectors,
  Mismatches,
  type Typed,
} from "./testing/vectors.js";

const GUARDS = guardsById();
const guard = (id: number | null) => (id === null ? null : (GUARDS.get(id) ?? null));

function blockHashes(fn: (s: string) => string): string[] {
  const out: string[] = [];
  for (let block = 0; block < 0x110000 / 4096; block++) {
    const h = createHash("sha256");
    for (let c = block * 4096; c < (block + 1) * 4096; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      h.update(fn(String.fromCodePoint(c)), "utf8");
      h.update("\0");
    }
    out.push(h.digest("hex").slice(0, 16));
  }
  return out;
}

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
  for (const [name, fn] of cases) {
    it(`${name} matches Python on every code point`, () => {
      expect(blockHashes(fn)).toEqual(file[name]);
    });
  }
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
  it(`replays ${rows.length} synthetic texts`, () => {
    const m = new Mismatches();
    for (const [i, r] of rows.entries()) {
      const g = guard(r.guard);
      m.check(`#${i} strict`, scrubText(r.text, { strict: true, guard: g }), r.strict);
      m.check(`#${i} amounts`, scrubText(r.text, { strict: false, guard: g }), r.amounts);
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
  it(`replays ${rows.length} names`, () => {
    const m = new Mismatches();
    for (const [i, r] of rows.entries()) {
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
  it(`replays ${masks.length} masks and payee resolutions`, () => {
    const m = new Mismatches();
    for (const [i, r] of masks.entries()) {
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
  it(`replays ${rows.length} provider sets`, () => {
    const m = new Mismatches();
    for (const [i, r] of rows.entries()) {
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
  it(`replays ${rows.length} numbers`, () => {
    const m = new Mismatches();
    for (const [i, r] of rows.entries()) {
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
});

describe("market text", () => {
  const file = loadVectors<{
    vocabulary: string[];
    summary_max: number;
    rows: { text: string; market_ok: boolean; summary_ok: boolean }[];
  }>("market");
  const check = macro.summaryChecker(new Set(file.vocabulary), file.summary_max);
  it("the summary vocabulary and maximum are the domain macro module's", () => {
    expect([...macro.vocabulary()].sort()).toEqual([...file.vocabulary].sort());
    expect(macro.SUMMARY_MAX).toBe(file.summary_max);
  });
  it(`replays ${file.rows.length} market texts`, () => {
    const m = new Mismatches();
    for (const [i, r] of file.rows.entries()) {
      m.check(`#${i} market_ok`, marketOk(r.text, check), r.market_ok);
      m.check(`#${i} summary_ok`, check(r.text), r.summary_ok);
    }
    expect(m.items, m.report()).toEqual([]);
  });
});

type TreeOutcome =
  | { out: string; isins: string[] }
  | { error: "leak"; isins: string[] }
  | { error: "unlabelled" };

describe("Redactor + leakCheck on random labelled trees", () => {
  const file = loadVectors<{
    rows: { guard: number | null; tree: EncodedTree; strict: TreeOutcome; amounts: TreeOutcome }[];
  }>("trees");
  const vocabulary = loadVectors<{ vocabulary: string[] }>("market").vocabulary;
  const summaryOk = macro.summaryChecker(new Set(vocabulary));
  it(`replays ${file.rows.length} trees in both privacy levels`, () => {
    const m = new Mismatches();
    for (const [i, r] of file.rows.entries()) {
      for (const privacy of ["strict", "amounts"] as const) {
        const redactor = new Redactor({ privacy, guard: guard(r.guard), summaryOk });
        let got: TreeOutcome;
        try {
          const data = redactor.apply(decodeTree(r.tree));
          try {
            leakCheck(data, { strict: redactor.strict, isins: redactor.isins });
            got = { out: pyDumps(data), isins: [...redactor.isins].sort() };
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
    }
    expect(m.items, m.report()).toEqual([]);
  });
});

describe("scrubAmountLiterals over the Python parser's trees", () => {
  const file = loadVectors<{
    rows: { source: string; scrubbed: string; scrubbed_private: string }[];
  }>("expressions");
  const deps = exprDepsFromVectors();
  it(`replays ${file.rows.length} expressions`, () => {
    const m = new Mismatches();
    for (const [i, r] of file.rows.entries()) {
      m.check(`#${i} scrub`, scrubAmountLiterals(r.source, deps), r.scrubbed);
      m.check(
        `#${i} private`,
        scrubAmountLiterals(r.source, deps, { privatePrices: true }),
        r.scrubbed_private,
      );
    }
    expect(m.items, m.report()).toEqual([]);
  });
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
  it("lists the same schemas and modules", () => {
    for (const s of file.specs) {
      const spec = specs.get(s.name) as ToolSpec<never>;
      expect(inputSchema(spec)).toEqual(s.input_schema);
      for (const mod of Object.keys(s.enabled)) {
        expect(enabledIn(spec, new Set([mod]))).toBe(s.enabled[mod]);
        expect(listedModule(spec, new Set([mod]))).toBe(s.listed[mod]);
      }
    }
  });
  it(`replays ${file.rows.length} argument sets`, () => {
    const m = new Mismatches();
    for (const [i, r] of file.rows.entries()) {
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
