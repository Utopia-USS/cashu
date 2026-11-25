import { expect, it } from "vitest";
import { pyReprStr } from "./pyRepr.js";

// Python repr(str) quotes values in strategy.yaml errors (pyYaml/*) and alert messages
// (investments/alerts/messages.ts).
it("pyReprStr picks the quote and escapes like Python", () => {
  expect(pyReprStr("it's")).toBe('"it\'s"');
  expect(pyReprStr("both ' and \"")).toBe("'both \\' and \"'");
  expect(pyReprStr("")).toBe("''");
  expect(pyReprStr("a\nb\t\\")).toBe("'a\\nb\\t\\\\'");
  expect(pyReprStr("zł\u0000")).toBe("'zł\\x00'");
});
