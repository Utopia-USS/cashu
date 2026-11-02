/** Native overview including home attention, raw legacy alerts and actual global FX freshness. */
import { investments as inv } from "@cashu/domain";
import { investmentsViews } from "@cashu/store";
import type { PythonDb } from "../../sources/pythonDb.ts";
import type { OutValue } from "../output.ts";
import { viewOutput } from "./viewOutput.ts";
import {
  copiedProjectionInput,
  copiedScalarFloatPaths,
  copiedWarningMessages,
  nativeViewSources,
} from "./viewSource.ts";
export function produceOverview(db: PythonDb): OutValue {
  return Object.fromEntries(
    nativeViewSources(db).map((source) => {
      const input = copiedProjectionInput(db, source, { forOwner: true });
      const dates = input.state.valued.valued.flatMap(
        (holding) => source.marketData.data.lastBarDate(holding.instrument.id) ?? [],
      );
      const newestBarDate = dates.length === 0 ? null : dates.reduce((a, b) => (a > b ? a : b));
      const native = inv.views.overviewView({
        ...input,
        strategyStatus: investmentsViews.nativeStrategyStatus(source.strategy),
        newestRateDate: db.investmentsViews.newestRateDate(),
        newestBarDate,
      });
      const value = {
        ...native,
        warnings: copiedWarningMessages(native.warnings, input.state, source),
      };
      return [
        db.keys.key("profiles", source.profile.id),
        viewOutput(value, db, source.vault, {
          floatPaths: [...inv.views.OVERVIEW_FLOAT_PATHS, ...copiedScalarFloatPaths(value, source)],
          literalIdPaths: ["allocation.buckets.*.id"],
        }),
      ];
    }),
  );
}
