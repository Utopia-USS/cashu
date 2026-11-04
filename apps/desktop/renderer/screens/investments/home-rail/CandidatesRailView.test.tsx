import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CandidatesRailView, type CandidatesRailViewProps } from "./CandidatesRailView.js";

const base: CandidatesRailViewProps = {
  privacy: false,
  available: true,
  freshCount: 1,
  totalOpen: 4,
  rows: [
    {
      id: "c-1",
      tile: "ACM",
      name: "Synthetic company",
      sentence: "Synthetic headline.",
      watched: false,
      busy: false,
      criteria: [],
      context: null,
      onWatch() {},
      onDismiss() {},
    },
  ],
  notice: null,
  onAll() {},
};

describe("CandidatesRailView", () => {
  it("shows a plain candidate row with actions and hides private content", () => {
    const shown = renderToStaticMarkup(<CandidatesRailView {...base} />);
    expect(shown).toContain("Synthetic headline.");
    expect(shown).toContain("ACM");
    expect(shown).toContain('aria-expanded="false"');
    const hidden = renderToStaticMarkup(<CandidatesRailView {...base} privacy />);
    expect(hidden).not.toContain("Synthetic company");
    expect(hidden).not.toContain("Synthetic headline.");
  });
});
