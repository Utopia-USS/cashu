/** Actual native allocation view, with every band/match field retained. */
import { investments as inv } from "@cashu/domain";
import type { PythonDb } from "../../sources/pythonDb.ts";
import type { OutValue } from "../output.ts";
import { viewOutput } from "./viewOutput.ts";
import { copiedProjectionInput, nativeViewSources } from "./viewSource.ts";
export function produceAllocationView(db: PythonDb): OutValue {
  return Object.fromEntries(
    nativeViewSources(db).map((source) => {
      const value = inv.views.allocationView(copiedProjectionInput(db, source));
      return [
        db.keys.key("profiles", source.profile.id),
        {
          view: viewOutput(value, db, source.vault, {
            floatPaths: inv.views.ALLOCATION_FLOAT_PATHS,
            literalIdPaths: ["buckets.*.id"],
          }),
        },
      ];
    }),
  );
}
