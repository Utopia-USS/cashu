/** Native positions with actual annotations over explicit legacy alert/rank input facts. */
import { investments as inv } from "@cashu/domain";
import type { PythonDb } from "../../sources/pythonDb.ts";
import type { OutValue } from "../output.ts";
import { viewOutput } from "./viewOutput.ts";
import { copiedProjectionInput, nativeViewSources } from "./viewSource.ts";
export function producePositions(db: PythonDb): OutValue {
  return Object.fromEntries(
    nativeViewSources(db).map((source) => {
      const value = inv.views.positionsView(copiedProjectionInput(db, source));
      return [
        db.keys.key("profiles", source.profile.id),
        viewOutput(value, db, source.vault, { floatPaths: inv.views.POSITIONS_FLOAT_PATHS }),
      ];
    }),
  );
}
