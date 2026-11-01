/// <reference types="node" />
// The shared synthetic adversarial vectors (S37fix): the same file drives the Python test
// (tests/test_mcp_privacy_vectors.py), so both languages close the same leaks. Byte equality with
// Python on these texts (and a fuzz around them) is checked by the "adversarial" vector section.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as L from "./labels.js";
import { customCondition, scrubNumbers } from "./messages.js";
import { NameGuard } from "./names.js";
import type { JsonValue } from "./pyJson.js";
import { LeakDetected, leakCheck, Redactor, UnlabelledValue } from "./redactor.js";
import { scrubText } from "./scrub.js";
import { exprDepsFromVectors } from "./testing/vectors.js";

type Mode = "strict" | "amounts";

interface Vectors {
  readonly guard_names: string[];
  readonly texts: {
    finding: string;
    text: string;
    modes: Mode[];
    absent: string[];
    expect?: Partial<Record<Mode, string>>;
    guard?: boolean;
    note?: string;
  }[];
  readonly symbols: {
    finding: string;
    symbol: string;
    strict_absent?: string[];
    expect?: Record<Mode, string>;
  }[];
  readonly dates_refused: { finding: string; date: string }[];
  readonly dates_kept: string[];
  readonly leaks: { finding: string; tree: JsonValue; strict: boolean; leak: boolean }[];
  readonly authored: {
    finding: string;
    text: string;
    expect: Partial<Record<Mode, string>>;
    owner_strict?: string;
  }[];
  readonly known_symbols: string[];
  readonly symbols_known: { finding: string; symbol: string; expect: Record<Mode, string> }[];
  readonly expressions: { finding: string; source: string; absent: string[]; expect: string }[];
  readonly messages: { finding: string; text: string; absent: string[]; expect: string }[];
}

const url = new URL("../../../../tests/mcp_privacy_vectors.json", import.meta.url);
/** JSON integers as Python ints (`bigint`), like the Python test reads them. */
const VECTORS = JSON.parse(readFileSync(fileURLToPath(url), "utf8"), (_key, value) =>
  typeof value === "number" && Number.isInteger(value) ? BigInt(value) : value,
) as Vectors;
const GUARD = new NameGuard({ profileId: 1, names: VECTORS.guard_names });

describe("text vectors", () => {
  it.each(
    VECTORS.texts.map((v) => [`${v.finding}: ${v.note ?? JSON.stringify(v.text)}`, v] as const),
  )("%s", (_id, v) => {
    for (const mode of v.modes) {
      const redactor = new Redactor({ privacy: mode, guard: v.guard ? GUARD : null });
      const out = redactor.apply({ note: L.text(v.text) });
      const sent = (out as { note: string }).note;
      for (const secret of v.absent) expect(sent, mode).not.toContain(secret);
      const expected = v.expect?.[mode];
      if (expected !== undefined) expect(sent).toBe(expected);
      leakCheck(out, {
        strict: redactor.strict,
        isins: redactor.isins,
        nonMoney: redactor.nonMoney,
      });
    }
  });
});

describe("symbol vectors", () => {
  it.each(VECTORS.symbols.map((v) => [v.symbol, v] as const))("%s", (_id, v) => {
    for (const mode of ["strict", "amounts"] as const) {
      const redactor = new Redactor({ privacy: mode });
      const out = redactor.apply({ symbol: L.symbol(v.symbol) });
      const sent = (out as { symbol: string }).symbol;
      if (mode === "strict")
        for (const secret of v.strict_absent ?? []) expect(sent).not.toContain(secret);
      if (v.expect) expect(sent).toBe(v.expect[mode]);
      leakCheck(out, { strict: redactor.strict, isins: redactor.isins });
    }
  });
});

describe("date label", () => {
  it.each(VECTORS.dates_refused.map((v) => v.date))("refuses %s", (value) => {
    for (const privacy of ["strict", "amounts"]) {
      expect(() => new Redactor({ privacy }).apply({ at: L.date(value) })).toThrow(UnlabelledValue);
    }
  });
  it.each(VECTORS.dates_kept)("keeps %s", (value) => {
    expect(new Redactor({ privacy: "strict" }).apply({ at: L.date(value) })).toEqual({ at: value });
  });
});

describe("leak check vectors", () => {
  it.each(
    VECTORS.leaks.map(
      (v) =>
        [JSON.stringify(v.tree, (_k, x) => (typeof x === "bigint" ? Number(x) : x)), v] as const,
    ),
  )("%s", (_id, v) => {
    const check = () => leakCheck(v.tree, { strict: v.strict });
    if (v.leak) expect(check).toThrow(LeakDetected);
    else expect(check).not.toThrow();
  });
});

describe("authored text (S37fix R3: cashU's own constant text)", () => {
  it.each(VECTORS.authored.map((v) => [`${v.finding}: ${v.text}`, v] as const))("%s", (_id, v) => {
    for (const [mode, expected] of Object.entries(v.expect)) {
      const redactor = new Redactor({ privacy: mode, guard: GUARD });
      const out = redactor.apply({ f: L.fixedText(v.text) });
      expect(out).toEqual({ f: expected });
      leakCheck(out, { strict: redactor.strict, isins: redactor.isins });
    }
    if (v.owner_strict !== undefined) {
      const owner = new Redactor({ privacy: "strict", guard: GUARD }).apply({ t: L.text(v.text) });
      expect(owner).toEqual({ t: v.owner_strict });
    }
  });
});

describe("known digit-only symbols (S37fix R5)", () => {
  const guard = new NameGuard({
    profileId: 1,
    names: VECTORS.guard_names,
    symbols: VECTORS.known_symbols,
  });
  it.each(VECTORS.symbols_known.map((v) => [v.symbol, v] as const))("%s", (_id, v) => {
    for (const mode of ["strict", "amounts"] as const) {
      expect(new Redactor({ privacy: mode, guard }).apply({ s: L.symbol(v.symbol) })).toEqual({
        s: v.expect[mode],
      });
    }
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

describe("strict custom conditions (S37fix3 E1 / E2 / E4)", () => {
  const deps = exprDepsFromVectors();
  it.each(VECTORS.expressions.map((v) => [`${v.finding}: ${v.source}`, v] as const))(
    "%s",
    (_id, v) => {
      const out = customCondition({ strict: true }, v.source, deps).value as string;
      for (const secret of v.absent) expect(out).not.toContain(secret);
      expect(out).toBe(v.expect);
      const sent = new Redactor({ privacy: "strict", guard: GUARD }).apply({
        expression: customCondition({ strict: true }, v.source, deps),
      }) as { expression: string };
      for (const secret of v.absent) expect(sent.expression).not.toContain(secret);
    },
  );
});

describe("strict system messages (S37fix3 E2)", () => {
  it.each(VECTORS.messages.map((v) => [`${v.finding}: ${v.text}`, v] as const))("%s", (_id, v) => {
    const out = scrubNumbers(v.text);
    for (const secret of v.absent) expect(out).not.toContain(secret);
    expect(out).toBe(v.expect);
  });
});
