/** Native detail and chart use separate 730-day detail/full chart inputs from the same store. */
import { addDays, investments as inv, toStorage } from "@cashu/domain";
import { investmentsViews } from "@cashu/store";
import type { PythonDb } from "../../sources/pythonDb.ts";
import type { OutValue } from "../output.ts";
import { viewOutput } from "./viewOutput.ts";
import { copiedProjectionInput, copiedSourceId, nativeViewSources } from "./viewSource.ts";
export function producePositionDetail(db: PythonDb): OutValue {
  return Object.fromEntries(
    nativeViewSources(db).map((source) => {
      const input = copiedProjectionInput(db, source);
      const held = [...new Set(input.state.valued.valued.map((row) => row.instrument.id))];
      const per: Record<string, OutValue> = {};
      for (const id of held) {
        const instrument = input.state.instruments.get(id);
        if (instrument === undefined) throw new Error("native detail instrument is absent");
        const loaded = investmentsViews.positionHistory(
          source.vault.store.read.bind(source.vault.store),
          id,
        );
        const history: inv.views.PositionHistory = {
          ...loaded,
          theses: [...loaded.theses].sort((a, b) =>
            toStorage(a.createdAt) < toStorage(b.createdAt)
              ? 1
              : toStorage(a.createdAt) > toStorage(b.createdAt)
                ? -1
                : copiedSourceId(source, b.id) - copiedSourceId(source, a.id),
          ),
          decisions: [...loaded.decisions].sort((a, b) =>
            toStorage(a.createdAt) < toStorage(b.createdAt)
              ? 1
              : toStorage(a.createdAt) > toStorage(b.createdAt)
                ? -1
                : copiedSourceId(source, b.id) - copiedSourceId(source, a.id),
          ),
        };
        const chartBars = input.state.historyBars.get(id) ?? [];
        const detailBars = chartBars.filter((bar) => bar.date >= addDays(input.state.asOf, -730));
        const detail = inv.views.positionDetailView({
          ...input,
          instrument,
          chartBars,
          detailBars,
          history,
        });
        const chart = inv.views.positionChartView({
          ...input,
          instrument,
          bars: chartBars,
          months: 24,
        });
        const key = db.keys.key("inv_instruments", copiedSourceId(source, id, "inv_instruments"));
        per[key] = {
          detail: viewOutput(detail, db, source.vault, {
            floatPaths: inv.views.POSITION_DETAIL_FLOAT_PATHS,
          }),
          chart_24m: viewOutput(chart, db, source.vault, {
            floatPaths: inv.views.POSITION_CHART_FLOAT_PATHS,
            literalIdPaths: ["thresholds.*.rule_id"],
          }),
        };
      }
      return [db.keys.key("profiles", source.profile.id), per];
    }),
  );
}
