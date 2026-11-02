/** Native complete watched rows; the declared bare-id override matches the Python check. */
import { investments as inv } from "@cashu/domain";
import type { PythonDb } from "../../sources/pythonDb.ts";
import type { OutValue } from "../output.ts";
import { viewOutput } from "./viewOutput.ts";
import { copiedProjectionInput, nativeViewSources } from "./viewSource.ts";
export function produceWatchlist(db: PythonDb): OutValue {
  return Object.fromEntries(
    nativeViewSources(db).map((source) => {
      const value = inv.views.watchlistView(copiedProjectionInput(db, source));
      return [
        db.keys.key("profiles", source.profile.id),
        viewOutput(value, db, source.vault, {
          floatPaths: inv.views.WATCHLIST_FLOAT_PATHS,
          bareIdTable: "watchlist_items",
        }),
      ];
    }),
  );
}
