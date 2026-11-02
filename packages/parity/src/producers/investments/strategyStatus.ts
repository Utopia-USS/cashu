/** Genuine native strategy status service over copied files and folded versions. */
import { investments as inv } from "@cashu/domain";
import { investmentsViews } from "@cashu/store";
import type { PythonDb } from "../../sources/pythonDb.ts";
import type { OutValue } from "../output.ts";
import {
  STRATEGY_STATUS_FLOAT_PATHS,
  STRATEGY_STATUS_LITERAL_IDS,
  viewOutput,
} from "./viewOutput.ts";
import { nativeViewSources } from "./viewSource.ts";

export function produceStrategyStatus(db: PythonDb): OutValue {
  return Object.fromEntries(
    nativeViewSources(db).map((source) => {
      if (source.profile.baseCurrency === null)
        throw new Error("native view profile has no base currency");
      const prefix = `profiles/${source.profile.slug}/`;
      const files = db.files();
      const value = investmentsViews.projectStoredStrategyStatus(
        source.vault.store.read.bind(source.vault.store),
        {
          state: source.strategy,
          profileBase: inv.toCurrency(source.profile.baseCurrency),
          lang: "en",
          files: {
            yaml: `$DATA_DIR/${prefix}strategy.yaml`,
            md: `$DATA_DIR/${prefix}strategy.md`,
            yamlExists: files.read(`${prefix}strategy.yaml`) !== undefined,
            mdExists: files.read(`${prefix}strategy.md`) !== undefined,
          },
        },
      );
      return [
        db.keys.key("profiles", source.profile.id),
        viewOutput(value, db, source.vault, {
          floatPaths: STRATEGY_STATUS_FLOAT_PATHS,
          literalIdPaths: STRATEGY_STATUS_LITERAL_IDS,
        }),
      ];
    }),
  );
}
