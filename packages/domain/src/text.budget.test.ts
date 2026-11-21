import { describe, expect, it } from "vitest";
import { pyIsDigit, pySplitlines, pyStripChars } from "./text.js";

// Python str semantics the bank parsers (statements/mbank.ts, erste.ts, pekao.ts, delimited.ts), the
// canonical budget import (canonical/csvVariant.ts) and the MCP redactor (mcp privacy/redactor.ts) rely on.
describe("Python text helpers", () => {
  it("isdigit is true for every decimal digit and the superscript / circled digits", () => {
    for (const ch of ["0", "9", "٣", "۷", "５", "²", "①", "⁴"])
      expect(pyIsDigit(ch.codePointAt(0) as number), ch).toBe(true);
    for (const ch of ["a", " ", "-", ".", "½", "Ⅻ"])
      expect(pyIsDigit(ch.codePointAt(0) as number), ch).toBe(false);
  });

  it("splitlines splits on every Python line break, CRLF once, no trailing empty line", () => {
    expect(pySplitlines("")).toEqual([]);
    expect(pySplitlines("a\r\nb\rc\nd\n")).toEqual(["a", "b", "c", "d"]);
    expect(pySplitlines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(pySplitlines("a\u000bb\u000cc\u001cd\u0085e f")).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(pySplitlines("\ra")).toEqual(["", "a"]);
  });

  it("strip(chars) removes any of the given code points from the chosen side", () => {
    expect(pyStripChars('"";"x";""', '";')).toBe("x");
    expect(pyStripChars("'- 1 -'", "'-", "left")).toBe(" 1 -'");
    expect(pyStripChars("'- 1 -'", "'-", "right")).toBe("'- 1 ");
    expect(pyStripChars("😀a😀", "😀")).toBe("a");
    expect(pyStripChars("abc", "")).toBe("abc");
  });
});
