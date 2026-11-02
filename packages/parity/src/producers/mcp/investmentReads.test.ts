/** Actual Python handler/redactor bytes over synthetic SQL; native inputs never contain answers. */
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { type CanonObject, parseCanonical } from "../../json.ts";
import { withPythonDb } from "../../sources/pythonDb.ts";
import { type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { nativeProfileMcpReads } from "./privacy.ts";
import { canonToOut } from "./rawTrees.ts";

const source = JSON.parse(
  readFileSync(new URL("../investments/fixtures/review-views.json", import.meta.url), "utf8"),
) as { sql: string; files: Record<string, string> };
const expected = parseCanonical(
  readFileSync(new URL("./fixtures/investments-read.json", import.meta.url), "utf8"),
) as CanonObject;
let ds: SyntheticDataset | undefined;
afterEach(() => ds?.dispose());
it.each(["strict", "amounts"] as const)(
  "matches actual Python native investments MCP output bytes in %s",
  (mode) => {
    for (const scenario of ["base", "edge"]) {
      const edge = expected.get("edge") as CanonObject;
      ds = syntheticDataset(source.sql + (scenario === "edge" ? `\n${edge.get("sql_delta")}` : ""));
      for (const [path, value] of Object.entries(source.files)) ds.writeFile(path, value);
      withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
        const wanted = (
          scenario === "base" ? expected.get("base") : edge.get("expected")
        ) as CanonObject;
        const modeExpected = wanted.get(mode) as CanonObject;
        for (const profile of db.profiles()) {
          const calls = modeExpected.get(db.keys.key("profiles", profile.id)) as CanonObject;
          const actual = nativeProfileMcpReads(db, mode, profile).native;
          if (scenario === "edge" && profile.id === 1) {
            const positions = actual["positions()"];
            if (positions === undefined) throw new Error("missing native positions");
            // Python view DTOs convert quantities to floats before MCP computes weighted days.
            expect(JSON.parse(dumps(positions)).positions[0].holding_days_avg).toBe(5);
            expect(actual["signals(status=all)"]).toEqual({ error_kind: "unlabelled" });
          }
          for (const [key, wanted] of calls) {
            const value = actual[key];
            if (value === undefined) throw new Error("missing native answer");
            expect(dumps(value), `${mode}/${key}`).toBe(dumps(canonToOut(wanted)));
          }
        }
      });
      ds.dispose();
      ds = undefined;
    }
  },
);
