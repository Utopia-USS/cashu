/// <reference types="node" />
// Long input: the scrub cap and linear time on adversarial repetition. Synthetic text only. Times are
// CPU time (process.cpuUsage), the best of three runs (the first compiles the patterns).
import { describe, expect, it } from "vitest";
import { scrubNumbers } from "./messages.js";
import { NameGuard } from "./names.js";
import { identifierIn, MAX_SCRUB_CHARS, scrubText, TRUNCATED } from "./scrub.js";

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

/** CPU seconds of one run of `fn`. */
function once(fn: () => unknown): number {
  const start = process.cpuUsage();
  fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1e6;
}

/**
 * CPU growth when the input grows four times: about 4 for a linear pass, 16 for a quadratic one. The
 * two sizes run in interleaved pairs, so machine load hits both runs of a pair alike, and the median of
 * the pairs' ratios is checked, not an absolute time: one run slowed by the scheduler or a GC pause
 * moves one pair, never the median.
 */
function growth(unit: string, n: number, fn: (text: string) => unknown): number {
  const text = (size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const small = text(n);
  const large = text(4 * n);
  fn(small); // compile the patterns outside the timing
  fn(large);
  const ratios: number[] = [];
  for (let i = 0; i < 7; i++) {
    const a = once(() => fn(small));
    const b = once(() => fn(large));
    ratios.push(b / Math.max(a, 1e-4));
  }
  return ratios.sort((x, y) => x - y)[3] as number;
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
    expect(growth(unit, 8_000, (t) => scrubText(t, { strict: true, guard: GUARD }))).toBeLessThan(
      8,
    );
  });
});

describe("many small kept numbers stay linear (S37fix3 D1)", () => {
  // the currency check before each kept number read the whole text before it ("12 pp " * 33000:
  // 9 s); it now reads a bounded window
  it.each(["12 pp ", "5 x ", "row 12 "])("%j", (unit) => {
    expect(scrubText(unit.repeat(2000), { strict: true })).not.toContain("[amount]");
    expect(growth(unit, 8_000, (t) => scrubText(t, { strict: true }))).toBeLessThan(8);
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
  // the cap counts code points
  const astral = "\u{1d400}".repeat(MAX_SCRUB_CHARS);
  expect(scrubText(astral, { strict: false })).toBe(astral);
});

it("never leaves the first half of a name at the cut", () => {
  const head = "x ".repeat(MAX_SCRUB_CHARS / 2 - 4);
  const out = scrubText(`${head}Anna Nowak dalej`, { strict: false });
  expect(out).not.toContain("Anna");
  expect(out.endsWith(TRUNCATED)).toBe(true);
});

it("masks every name of a text full of names", () => {
  expect(scrubText("Anna Nowak, ".repeat(3000), { strict: false, guard: GUARD })).toBe(
    "[name], ".repeat(3000),
  );
});
