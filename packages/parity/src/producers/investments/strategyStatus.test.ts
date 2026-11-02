import { readFileSync } from "node:fs";
import { investments as inv } from "@cashu/domain";
import { strategyStatus } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import type { PythonDb } from "../../sources/pythonDb.ts";
import { dumps } from "../output.ts";
import {
  STRATEGY_STATUS_FLOAT_PATHS,
  STRATEGY_STATUS_LITERAL_IDS,
  viewOutput,
} from "./viewOutput.ts";

interface Vector {
  readonly slug: string;
  readonly name: string;
  readonly yaml: string | null;
  readonly md: string | null;
  readonly versions: readonly inv.views.StrategyVersionFact[];
  readonly expected: unknown;
}
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/strategy-status.json", import.meta.url), "utf8"),
) as Vector[];
describe("actual Python strategy_status vectors", () => {
  for (const vector of vectors)
    it(vector.name, () => {
      const status = strategyStatus(
        { yaml: vector.yaml, md: vector.md, readError: null },
        vector.versions[0] ?? null,
      );
      const value = inv.views.strategyStatusView({
        status,
        profileBase: inv.Currencies.PLN,
        versions: vector.versions,
        lang: "en",
        files: {
          yaml: `$DATA_DIR/profiles/${vector.slug}/strategy.yaml`,
          md: `$DATA_DIR/profiles/${vector.slug}/strategy.md`,
          yamlExists: vector.yaml !== null,
          mdExists: vector.md !== null,
        },
      });
      const wire = viewOutput(
        value,
        {
          keys: {
            key: () => {
              throw new Error("unexpected synthetic reference");
            },
          },
        } as unknown as Pick<PythonDb, "keys">,
        { sources: new Map(), det: (() => "unused") as never },
        { floatPaths: STRATEGY_STATUS_FLOAT_PATHS, literalIdPaths: STRATEGY_STATUS_LITERAL_IDS },
      );
      expect(JSON.parse(dumps(wire))).toEqual(vector.expected);
    });
});
