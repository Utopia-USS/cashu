// The Strategie tab's Markdown parser (src/core/markdown.ts): blocks, inline markup, safe links, frontmatter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInline, parseMarkdown, safeHref, stripFrontmatter } from "../src/core/markdown.ts";

test("headings, paragraphs with soft and hard breaks, rules", () => {
  const b = parseMarkdown("# Tytuł #\n\nlinia jedna\nlinia dwa  \ntrzecia\n\n---\n## Dalej");
  assert.deepEqual(b[0], { t: "h", level: 1, c: ["Tytuł"] });
  assert.deepEqual(b[1], { t: "p", c: ["linia jedna linia dwa", { t: "br" }, "trzecia"] });
  assert.deepEqual(b[2], { t: "hr" });
  assert.equal(b[3].t, "h");
});

test("lists: nesting by indent, ordered start, task boxes, lazy lines", () => {
  const [list] = parseMarkdown("- [x] zrobione\n- [ ] do zrobienia\n  - zagnieżdżone\nciąg dalszy\n- trzeci");
  assert.equal(list.t, "list");
  assert.equal(list.ordered, false);
  assert.deepEqual(list.items.map((i) => i.task), [true, false, null]);
  const second = list.items[1].blocks;
  assert.deepEqual(second[0], { t: "p", c: ["do zrobienia"] });
  assert.equal(second[1].t, "list");
  assert.deepEqual(second[1].items[0].blocks, [{ t: "p", c: ["zagnieżdżone ciąg dalszy"] }]);
  const [ol] = parseMarkdown("3. trzy\n4. cztery");
  assert.equal(ol.ordered, true);
  assert.equal(ol.start, 3);
  assert.equal(ol.items.length, 2);
});

test("a loose list stays one list", () => {
  const b = parseMarkdown("- a\n\n- b\n\npo liście");
  assert.equal(b.length, 2);
  assert.equal(b[0].items.length, 2);
});

test("fenced code keeps its text, quotes nest blocks", () => {
  const b = parseMarkdown("```yaml\nrules:\n  - id: x\n```\n> **Uwaga**\n> - punkt");
  assert.deepEqual(b[0], { t: "code", lang: "yaml", v: "rules:\n  - id: x" });
  assert.equal(b[1].t, "quote");
  assert.deepEqual(b[1].blocks[0], { t: "p", c: [{ t: "b", c: ["Uwaga"] }] });
  assert.equal(b[1].blocks[1].t, "list");
});

test("tables with alignment and escaped pipes", () => {
  const [t] = parseMarkdown("| Koszyk | Cel |\n|:---|---:|\n| akcje \\| ETF | 80% |\n| obligacje |");
  assert.equal(t.t, "table");
  assert.deepEqual(t.align, ["left", "right"]);
  assert.deepEqual(t.head, [["Koszyk"], ["Cel"]]);
  assert.deepEqual(t.rows, [[["akcje | ETF"], ["80%"]], [["obligacje"], []]]);
});

test("inline: bold, italic, strike, code, links; snake_case and unclosed markers stay literal", () => {
  assert.deepEqual(parseInline("**gruby** i *kursywa* ~~nie~~ `kod`"), [
    { t: "b", c: ["gruby"] }, " i ", { t: "i", c: ["kursywa"] }, " ", { t: "s", c: ["nie"] }, " ", { t: "code", v: "kod" },
  ]);
  assert.deepEqual(parseInline("reguła max_drawdown_pct i 2 * 3"), ["reguła max_drawdown_pct i 2 * 3"]);
  assert.deepEqual(parseInline("[źródło](https://example.com)"), [{ t: "a", href: "https://example.com", c: ["źródło"] }]);
  assert.deepEqual(parseInline("[zły](javascript:alert(1))"), [{ t: "a", href: null, c: ["zły"] }, ")"]);
  assert.deepEqual(parseInline("\\*nie kursywa\\*"), ["*nie kursywa*"]);
});

test("safeHref keeps http(s) and mailto only; frontmatter is stripped", () => {
  assert.equal(safeHref("HTTPS://x.pl"), "HTTPS://x.pl");
  assert.equal(safeHref("mailto:a@example.com"), "mailto:a@example.com");
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref("/local"), null);
  assert.equal(stripFrontmatter("---\ntitle: X\n---\n# A"), "# A");
  assert.equal(stripFrontmatter("# A\n---\nb"), "# A\n---\nb");
  assert.deepEqual(parseMarkdown("---\nstatus: test\n---\n"), []);
});

test("raw HTML is text, never markup", () => {
  assert.deepEqual(parseMarkdown("<script>alert(1)</script>"), [{ t: "p", c: ["<script>alert(1)</script>"] }]);
});
