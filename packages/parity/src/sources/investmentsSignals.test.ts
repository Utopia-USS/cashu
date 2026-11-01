import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { withPythonDb } from "./pythonDb.ts";
import { type SyntheticDataset, syntheticDataset } from "./testing.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../producers/investments/fixtures/signals-view.json", import.meta.url),
    "utf8",
  ),
) as { sql: string };
let ds: SyntheticDataset | undefined;
afterEach(() => ds?.dispose());

it("reads only the selected profile's signals, decisions, links and rule runs", () => {
  ds = syntheticDataset(fixture.sql);
  withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
    expect(db.investments.signals(1).map((s) => s.id)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(db.investments.signals(2).map((s) => s.id)).toEqual([7]);
    expect(db.investments.signals(3)).toEqual([]);
    expect(db.investments.signalRuleRuns(1).map((r) => r.status)).toEqual([
      "failed",
      "partial",
      "ok",
    ]);
    expect(db.investments.signalRuleRuns(2)).toEqual([]);
    expect(db.investments.signalDecisions(1).map((d) => d.id)).toEqual([2, 1]);
    expect(db.investments.signalDecisions(2)).toEqual([]);
    expect(db.investments.decisionSignalLinks(1)).toHaveLength(3);
    expect(db.investments.decisionSignalLinks(2)).toEqual([]);
    const alert = db.investments.signals(1).find((r) => r.id === 2);
    expect(alert?.payload?.note_id).toBe(5n);
    expect(alert?.payload?.change).toBe(-0.2);
  });
});
