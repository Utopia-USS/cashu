import { expect, it } from "vitest";
import { proposalUnifiedDiff } from "./proposalDiff.js";

it("shows a proposal as a unified diff with three context lines, and nothing for no change", () => {
  expect(proposalUnifiedDiff("", "", "strategy.yaml")).toBe("");
  expect(proposalUnifiedDiff("", "x\n", "strategy.yaml")).toBe(
    "--- strategy.yaml (current)\n+++ strategy.yaml (proposed)\n@@ -0,0 +1 @@\n+x",
  );
  expect(proposalUnifiedDiff("old\na\nb\nc\nd\ne\n", "new\na\nb\nc\nd\ne\n", "strategy.md")).toBe(
    "--- strategy.md (current)\n+++ strategy.md (proposed)\n@@ -1,4 +1,4 @@\n-old\n+new\n a\n b\n c",
  );
  expect(
    proposalUnifiedDiff("a\nb\nc\nd\ne\nf\ng\n", "a\nb\nC\nd\ne\nf\nG\n", "strategy.yaml"),
  ).toBe(
    "--- strategy.yaml (current)\n+++ strategy.yaml (proposed)\n@@ -1,7 +1,7 @@\n a\n b\n-c\n+C\n d\n e\n f\n-g\n+G",
  );
});

it("refuses to diff an oversized file", () => {
  expect(proposalUnifiedDiff("a\n".repeat(20_001), "b\n", "strategy.yaml")).toBeNull();
});
