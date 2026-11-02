/** Same native accounts projector; copied row order is an explicit legacy compatibility fact. */
import { investments as inv } from "@cashu/domain";
import type { PythonDb } from "../../sources/pythonDb.ts";
import type { OutValue } from "../output.ts";
import { viewOutput } from "./viewOutput.ts";
import { copiedProjectionInput, nativeViewSources } from "./viewSource.ts";
export function produceAccounts(db: PythonDb): OutValue {
  return Object.fromEntries(
    nativeViewSources(db).map((source) => {
      const input = copiedProjectionInput(db, source);
      const value = inv.views.accountsView(input.state.accounts, input.state);
      return [
        db.keys.key("profiles", source.profile.id),
        viewOutput(value, db, source.vault, {
          floatPaths: inv.views.ACCOUNT_FLOAT_PATHS,
          bareIdTable: "accounts",
        }),
      ];
    }),
  );
}
