import { expect, it } from "vitest";
import { proposalUnifiedDiff } from "./proposalDiff.js";

it("matches Python unified_diff on synthetic strategy edits, insertions and no change", () => {
  // Expectations captured from the retired oracle (Python difflib.unified_diff, lineterm="") on 2026-11-04.
  const cases = [
    ["", "", "strategy.yaml", ""],
    [
      "",
      "x\n",
      "strategy.yaml",
      "--- strategy.yaml (current)\n+++ strategy.yaml (proposed)\n@@ -0,0 +1 @@\n+x",
    ],
    [
      "a\nb\nc\nd\ne\nf\ng\n",
      "a\nb\nC\nd\ne\nf\nG\n",
      "strategy.yaml",
      "--- strategy.yaml (current)\n+++ strategy.yaml (proposed)\n@@ -1,7 +1,7 @@\n a\n b\n-c\n+C\n d\n e\n f\n-g\n+G",
    ],
    [
      "rules:\n  - id: one\n",
      "rules:\n  - id: one\n  - id: two\n",
      "strategy.yaml",
      "--- strategy.yaml (current)\n+++ strategy.yaml (proposed)\n@@ -1,2 +1,3 @@\n rules:\n   - id: one\n+  - id: two",
    ],
    [
      "a\nb\nc\n",
      "a\nc\n",
      "strategy.md",
      "--- strategy.md (current)\n+++ strategy.md (proposed)\n@@ -1,3 +1,2 @@\n a\n-b\n c",
    ],
    [
      "old\na\nb\nc\nd\ne\n",
      "new\na\nb\nc\nd\ne\n",
      "strategy.md",
      "--- strategy.md (current)\n+++ strategy.md (proposed)\n@@ -1,4 +1,4 @@\n-old\n+new\n a\n b\n c",
    ],
    [
      "a\nb\nc\nd\ne\nold\n",
      "a\nb\nc\nd\ne\nnew\n",
      "strategy.md",
      "--- strategy.md (current)\n+++ strategy.md (proposed)\n@@ -3,4 +3,4 @@\n c\n d\n e\n-old\n+new",
    ],
    [
      "a\na\na\n",
      "a\nb\na\n",
      "strategy.yaml",
      "--- strategy.yaml (current)\n+++ strategy.yaml (proposed)\n@@ -1,3 +1,3 @@\n a\n+b\n a\n-a",
    ],
  ] as const;
  expect(cases.map(([old, next, name]) => proposalUnifiedDiff(old, next, name))).toEqual(
    cases.map(([, , , expected]) => expected),
  );
  expect(proposalUnifiedDiff("a\n".repeat(20_001), "b\n", "strategy.yaml")).toBeNull();
});
