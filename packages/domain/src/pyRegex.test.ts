import { describe, expect, it } from "vitest";
import { PY_B, pyRegex, translatePyPattern } from "./pyRegex.js";

/** The marker stands in for `\b` so the reference translation always uses the general `PY_B`. */
const MARK = "";

function general(python: string, extraFlags = ""): RegExp {
  const { source, ignoreCase } = translatePyPattern(python.replaceAll("\\b", MARK));
  return new RegExp(source.replaceAll(MARK, PY_B), `u${ignoreCase ? "i" : ""}${extraFlags}`);
}

const CORPUS = [
  "",
  "a",
  " foo ",
  "foo",
  "foo_bar foo-bar foo.bar foobar",
  "fooł łfoo foo1 1foo _foo foo_",
  "x2d x-d d- xd\\x2d \\d",
  "kupuj kupujcie kupujący, kupuj!",
  "ab abc bc a bc  abcbc",
  "ĄĆĘ ąćę İi ıI iİ",
  "áb á ́a",
  "\u{1d7d8}9 \u{1f600}a a\u{1f600} \u{10400}x",
  "  \t\n x y z w ",
  "12 3.4 5_6 7a b8",
];

const PATTERNS = [
  String.raw`\bfoo`,
  String.raw`foo\b`,
  String.raw`\bfoo\b`,
  String.raw`\b(?:foo|bar|ab\w*)`,
  String.raw`\b(?:kupuj(?:cie)?|ab|bc)\b`,
  String.raw`\b(?:a|)b`,
  String.raw`\b(?:a|\s)b?`,
  String.raw`\b(?:a|[b ])c?`,
  String.raw`\b(?:a|-)`,
  String.raw`\b(?:a|b)?c`,
  String.raw`\b(?:a|b)*c`,
  String.raw`\b(?=a)\w`,
  String.raw`\ba?b`,
  String.raw`\b\w+`,
  String.raw`\b\d`,
  String.raw`\b\s`,
  String.raw`\b[a-c]`,
  String.raw`\b.`,
  String.raw`\b(?:(?:ab|b)c|x)`,
  String.raw`\b(?<!a)b`,
  String.raw`\x2d\b`,
  String.raw`x\x2d\b`,
  String.raw`-\b`,
  String.raw`\\\b`,
  String.raw`\\d\b`,
  String.raw`\d\b`,
  String.raw`\w\b`,
  String.raw`a+\b`,
  String.raw`a?\b`,
  String.raw`a{1,2}\b`,
  String.raw`[a]\b`,
  String.raw`(?:a|b)\b`,
  String.raw`(?i)\b(?:kup[uú]j|iz)\b`,
  String.raw`(?i)\bi`,
  String.raw`(?i)i\b`,
];

describe("pyRegex \\b", () => {
  it.each(PATTERNS)("%s matches like the general boundary", (pattern) => {
    const fast = pyRegex(pattern, "g");
    const slow = general(pattern, "g");
    for (const text of CORPUS) {
      const a = [...text.matchAll(fast)].map((m) => [m.index, m[0]]);
      const b = [...text.matchAll(slow)].map((m) => [m.index, m[0]]);
      expect(a, JSON.stringify(text)).toEqual(b);
    }
  });

  it("uses a single lookaround where one side of the boundary is certainly a word character", () => {
    expect(translatePyPattern(String.raw`\bfoo`).source).not.toContain(PY_B);
    expect(translatePyPattern(String.raw`foo\b`).source).not.toContain(PY_B);
    expect(translatePyPattern(String.raw`\b(?:ab|c\w*)x`).source).not.toContain(PY_B);
  });

  it("keeps the general boundary where neither side is certain", () => {
    for (const pattern of [
      String.raw`\b(?:a|)b`,
      String.raw`\b\s`,
      String.raw`a?\b`,
      String.raw`\x2d\b`,
    ]) {
      expect(translatePyPattern(pattern).source, pattern).toContain(PY_B);
    }
  });
});
