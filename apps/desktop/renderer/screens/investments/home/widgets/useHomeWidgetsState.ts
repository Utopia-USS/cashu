// The widget-local state of the old Home widgets (ab24ab6 Perf.tsx:30 `table`, Portfolio.tsx:60-64 AssetList
// `adding` / `split` / `sort` / `classify`, Portfolio.tsx:215 DataWarnings `open`), kept in one hook the Home
// screen hook calls and spreads into the widgets' `ui`.
import { useState } from "react";
import type { AllocationUi } from "./allocationModel.js";
import type { AssetListUi } from "./assetListModel.js";
import type { ValueChartUi } from "./valueChartModel.js";

export type HomeWidgetsState = Pick<ValueChartUi, "table" | "onTable"> &
  Pick<AllocationUi, "warningsOpen" | "onWarnings"> &
  Pick<
    AssetListUi,
    "split" | "onSplit" | "sort" | "onSort" | "adding" | "onAdding" | "classify" | "onClassify"
  >;

export function useHomeWidgetsState(initial?: { adding?: boolean }): HomeWidgetsState {
  const [table, onTable] = useState(false);
  const [warningsOpen, onWarnings] = useState(false);
  const [split, onSplit] = useState<AssetListUi["split"]>("total");
  const [sort, onSort] = useState<AssetListUi["sort"]>("result");
  const [adding, onAdding] = useState(!!initial?.adding);
  const [classify, onClassify] = useState<string | null>(null);
  return {
    table,
    onTable,
    warningsOpen,
    onWarnings,
    split,
    onSplit,
    sort,
    onSort,
    adding,
    onAdding,
    classify,
    onClassify,
  };
}
