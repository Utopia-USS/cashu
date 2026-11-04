import type { ReadySignals } from "@cashu/store/investments/signals-screen";
import { useState } from "react";
import { type JournalFilter, journalModel } from "./journalModels.js";

/** The Journal page: decisions and signals of one instrument (or all) on a yearly timeline. */
export function useJournalPage(args: {
  readonly data: ReadySignals | null;
  readonly initialInstrument: string | null | undefined;
  readonly onUndo: (decision: string) => void;
  readonly onOpenAsset?: (gid: string) => void;
}) {
  const { data } = args;
  const [filter, setFilter] = useState<JournalFilter>("all");
  const [instrument, setInstrument] = useState(args.initialInstrument ?? "");
  const model =
    data === null ? { rows: [], decisions: 0, signals: 0 } : journalModel(data, instrument, filter);
  return {
    filter,
    instrument,
    instruments: (data?.instruments ?? []).map((row) => ({
      id: row.id,
      label: row.symbol ?? row.name,
    })),
    ...model,
    onFilter: setFilter,
    onInstrument: setInstrument,
    onUndo: args.onUndo,
    onOpenAsset: (gid: string) => args.onOpenAsset?.(gid),
  };
}
export type JournalPageState = ReturnType<typeof useJournalPage>;
