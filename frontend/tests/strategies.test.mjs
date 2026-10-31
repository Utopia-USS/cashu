// The Strategie tab's pure helpers (v2/strategiesLogic.ts): tree rows, selection, absolute paths, issue lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { absolutePath, issuesByLine, pickSelection, treeRows } from "../src/modules/investments/v2/strategiesLogic.ts";

const doc = (id, files, main_file = null, root = "/data/profiles/x/strategies/" + id) =>
  ({ id, main: id === "_main", executed: id === "_main", title: null, status: null, description: null, main_file, root, files: files.map((path) => ({ path, kind: path.endsWith(".md") ? "md" : "yaml" })) });

test("treeRows: the main document first, a folder row before its files", () => {
  const rows = treeRows(doc("swing", ["notes/b.md", "README.md", "rules.yaml", "notes/a.md"], "README.md"));
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.name}:${r.depth}`), [
    "file:README.md:0", "file:rules.yaml:0", "dir:notes:0", "file:a.md:1", "file:b.md:1",
  ]);
});

test("pickSelection keeps an existing choice, falls back to the strategy's document, else the first with files", () => {
  const list = [doc("_main", [], null), doc("swing", ["README.md", "rules.yaml"], "README.md")];
  assert.deepEqual(pickSelection(list, null), { id: "swing", path: "README.md" });
  assert.deepEqual(pickSelection(list, { id: "swing", path: "rules.yaml" }), { id: "swing", path: "rules.yaml" });
  assert.deepEqual(pickSelection(list, { id: "swing", path: "gone.md" }), { id: "swing", path: "README.md" });
  assert.deepEqual(pickSelection(list, { id: "_main", path: null }), { id: "_main", path: null });
  assert.deepEqual(pickSelection(list, { id: "gone", path: "x.md" }), { id: "swing", path: "README.md" });
  assert.equal(pickSelection([], null), null);
});

test("absolutePath joins the root with the platform separator", () => {
  assert.equal(absolutePath(doc("swing", ["notes/a.md"]), "notes/a.md"), "/data/profiles/x/strategies/swing/notes/a.md");
  assert.equal(absolutePath(doc("s", ["a/b.md"], null, "C:\\data\\strategies"), "a/b.md"), "C:\\data\\strategies\\a\\b.md");
});

test("issuesByLine groups issues on their line and skips those without one", () => {
  const m = issuesByLine([{ line: 3, m: "a" }, { line: null, m: "b" }, { line: 3, m: "c" }, { line: 7, m: "d" }]);
  assert.deepEqual([...m.keys()], [3, 7]);
  assert.equal(m.get(3).length, 2);
});
