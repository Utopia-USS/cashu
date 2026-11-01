/// <reference types="node" />
// Translation of tests/test_mcp_s37fix3.py: long input (the scrub cap and linear time) and the
// expression literal rules that are not plain vectors. Synthetic text only. Times are CPU time
// (process.cpuUsage), the best of three runs (the first compiles the patterns and fills the caches).
import { describe, expect, it } from "vitest";
import { scrubAmountLiterals } from "./exprLiterals.js";
import { customSignalMessage, scrubNumbers } from "./messages.js";
import { NameGuard } from "./names.js";
import { identifierIn, MAX_SCRUB_CHARS, scrubText, TRUNCATED } from "./scrub.js";
import { exprDepsFromVectors } from "./testing/vectors.js";

const GUARD = new NameGuard({ profileId: 1, names: ["ANNA NOWAK", "JAN KOWALSKI"] });
const WORD = "a".repeat(40_000);

function cpu(fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const start = process.cpuUsage();
    fn();
    const used = process.cpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1e6);
  }
  return best;
}

describe("a 40k-letter word scrubs in well under 100 ms", () => {
  it.each([
    [true, null],
    [false, null],
    [true, GUARD],
    [false, GUARD],
  ] as const)("strict %s, guard %#", (strict, guard) => {
    expect(scrubText(WORD, { strict, guard })).toBe(WORD);
    expect(cpu(() => scrubText(WORD, { strict, guard }))).toBeLessThan(0.1);
  });

  it("the leak check and system messages too", () => {
    expect(cpu(() => identifierIn(WORD))).toBeLessThan(0.1);
    expect(cpu(() => scrubNumbers(WORD))).toBeLessThan(0.1);
  });
});

describe("long texts of repeated shapes stay linear", () => {
  // each of these took seconds (or, "x", far longer) at 40k characters before S37fix3
  it.each([
    "a1 ",
    "Anna Nowak ",
    "https://x.pl/a1 ",
    "a@b.pl ",
    "dwa lub ",
    "x.",
    "ł",
    "x",
    "*",
    "x1",
  ])("%j", (unit) => {
    const text = unit.repeat(Math.ceil(40_000 / unit.length)).slice(0, 40_000);
    expect(cpu(() => scrubText(text, { strict: true, guard: GUARD }))).toBeLessThan(1);
  });
});

it("cuts a string over the cap before scrubbing", () => {
  const head = "x ".repeat(MAX_SCRUB_CHARS / 2 - 10);
  const out = scrubText(`${head}karta 4532 0151 1283 0366 dalej`, { strict: false });
  expect(out.endsWith(TRUNCATED)).toBe(true);
  // the cut drops the split word and the digits before it: no half of the card is left
  expect(out).not.toContain("4532");
  expect(out).not.toContain("0151");
  expect(out.length).toBeLessThanOrEqual(MAX_SCRUB_CHARS + TRUNCATED.length);
  expect(scrubText("x".repeat(MAX_SCRUB_CHARS), { strict: true })).toBe(
    "x".repeat(MAX_SCRUB_CHARS),
  );
  expect(scrubText("x".repeat(MAX_SCRUB_CHARS + 1), { strict: true })).toBe(TRUNCATED);
  // the cap counts code points, as Python's len does
  const astral = "\u{1d400}".repeat(MAX_SCRUB_CHARS);
  expect(scrubText(astral, { strict: false })).toBe(astral);
});

it("masks every name of a text full of names", () => {
  expect(scrubText("Anna Nowak, ".repeat(3000), { strict: false, guard: GUARD })).toBe(
    "[name], ".repeat(3000),
  );
});

describe("the percent exemption needs at most three integer digits", () => {
  const deps = exprDepsFromVectors();
  it.each([
    // does not parse: the fallback keeps small percentages only
    ["cash_value < 0080000% or broken (", "cash_value < [amount]% or broken ("],
    ["cash_value < 80000%", "cash_value < [amount]"],
    ["weight * 12000000% > 900", "weight * [amount] > [amount]"],
    ["cash_weight > 10%", "cash_weight > 10%"],
  ])("%s", (source, expected) => {
    expect(scrubAmountLiterals(source, deps)).toBe(expected);
  });
});

it("scrubs the text literals of the condition inside a custom signal message", () => {
  const deps = exprDepsFromVectors();
  const when = 'holding_has_tag("buffer 800") and weight < 0.5';
  const message = `bufor: Warunek spełniony: ${when} (cash_value 7 312,00 zł).`;
  const out = customSignalMessage({ strict: true }, message, when, deps).value as string;
  expect(out).not.toContain("800");
  expect(out).not.toContain("7 312");
  expect(out).toContain('holding_has_tag("buffer [amount]") and weight < 0.5');
});

describe("many small kept numbers stay linear (S37fix3 D1)", () => {
  // the currency check before each kept number read the whole text before it ("12 pp " * 33000:
  // 9 s); it now reads a bounded window. The whole strict scrub of these ~200k characters costs
  // ~0.3 s of CPU (the per-character passes), not the 100 ms of a 40k word.
  it.each(["12 pp ", "5 x ", "row 12 "])("%j", (unit) => {
    const text = unit.repeat(Math.floor(198_000 / unit.length));
    expect(scrubText(text, { strict: true })).not.toContain("[amount]");
    expect(cpu(() => scrubText(text, { strict: true }))).toBeLessThan(1.5);
  });
});

it("never leaves the first half of a name at the cut", () => {
  const head = "x ".repeat(MAX_SCRUB_CHARS / 2 - 4);
  const out = scrubText(`${head}Anna Nowak dalej`, { strict: false });
  expect(out).not.toContain("Anna");
  expect(out.endsWith(TRUNCATED)).toBe(true);
});
