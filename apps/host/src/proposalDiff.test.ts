import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { proposalUnifiedDiff } from "./proposalDiff.js";

it("matches Python unified_diff on synthetic strategy edits, insertions and no change", () => {
  const cases = [
    ["", "", "strategy.yaml"],
    ["", "x\n", "strategy.yaml"],
    ["a\nb\nc\nd\ne\nf\ng\n", "a\nb\nC\nd\ne\nf\nG\n", "strategy.yaml"],
    ["rules:\n  - id: one\n", "rules:\n  - id: one\n  - id: two\n", "strategy.yaml"],
    ["a\nb\nc\n", "a\nc\n", "strategy.md"],
    ["old\na\nb\nc\nd\ne\n", "new\na\nb\nc\nd\ne\n", "strategy.md"],
    ["a\nb\nc\nd\ne\nold\n", "a\nb\nc\nd\ne\nnew\n", "strategy.md"],
    ["a\na\na\n", "a\nb\na\n", "strategy.yaml"],
  ] as const;
  const oracle = spawnSync(
    "python3",
    [
      "-c",
      `import difflib,json,sys
for old,new,name in json.load(sys.stdin):
 print(json.dumps('\\n'.join(difflib.unified_diff(old.splitlines(),new.splitlines(),fromfile=f'{name} (current)',tofile=f'{name} (proposed)',lineterm=''))))`,
    ],
    { input: JSON.stringify(cases), encoding: "utf8" },
  );
  expect(oracle.status).toBe(0);
  const expected = oracle.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string);
  expect(cases.map(([old, next, name]) => proposalUnifiedDiff(old, next, name))).toEqual(expected);
  expect(proposalUnifiedDiff("a\n".repeat(20_001), "b\n", "strategy.yaml")).toBeNull();
});
