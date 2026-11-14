/**
 * Test-for-test translation of `tests/investments/research/test_rs_strategy_text.py`: strategy.md
 * sections for research (beliefs, entry / exit rules, what the owner avoids): heading keywords in
 * Polish and English, nested headings stay inside their section, code fences are not headings, long
 * sections are bounded. Synthetic markdown only (plus the shipped passive_etf template).
 */
import { describe, expect, it } from "vitest";
import { strategyTemplate } from "../strategy/index.js";
import { SECTION_MAX, strategySections } from "./strategyText.js";

/** `templates.strategy_template(name).markdown`: the shipped template text. */
function strategyTemplateMarkdown(name: string): string {
  return strategyTemplate(name)?.markdown ?? "";
}

describe("strategy text sections (test_rs_strategy_text.py)", () => {
  // test_template_sections
  it("template sections", () => {
    const sections = strategySections(strategyTemplateMarkdown("passive_etf"));
    expect(sections.map((s) => s.kind)).toEqual(["entry_exit", "avoid"]);
    expect(sections[1]?.heading).toBe("Czego unikam");
  });

  // test_keywords_nesting_fences_and_bounds
  it("keywords, nesting, fences and bounds", () => {
    const md = [
      "# Strategia",
      "## Cel",
      "Emerytura.",
      "## Moje przekonania",
      "Rynek rosnie dlugoterminowo.",
      "### Szczegoly",
      "Nadal przekonania.",
      "## Entry and exit rules",
      "```",
      "# not a heading",
      "```",
      "Buy on dips.",
      "## Czego unikam",
      "",
      "## Wykluczenia",
      "x".repeat(SECTION_MAX + 500),
      "## Notatki",
      "Koniec.",
    ].join("\n");
    const sections = strategySections(md);
    // the empty "Czego unikam" is skipped
    expect(sections.map((s) => [s.kind, s.heading])).toEqual([
      ["beliefs", "Moje przekonania"],
      ["entry_exit", "Entry and exit rules"],
      ["avoid", "Wykluczenia"],
    ]);
    expect(sections[0]?.text).toContain("### Szczegoly");
    expect(sections[0]?.text).toContain("Nadal");
    expect(sections[1]?.text).toContain("# not a heading");
    expect(sections[2]?.text.length).toBeLessThanOrEqual(SECTION_MAX + 4);
    expect(sections[2]?.text.endsWith("...")).toBe(true);
    expect(sections.every((s) => !s.text.includes("Emerytura") && !s.text.includes("Koniec"))).toBe(
      true,
    );
    expect(strategySections(null)).toEqual([]);
    expect(strategySections("")).toEqual([]);
  });
});
