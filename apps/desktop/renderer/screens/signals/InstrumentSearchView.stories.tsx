import { InstrumentSearchView } from "./InstrumentSearchView.js";

export default { title: "Signals/InstrumentSearch", component: InstrumentSearchView };

export const Results = {
  args: {
    inputRef: null,
    value: "syn",
    onChange() {},
    onKeyDown() {},
    placeholder: "Ticker, name or ISIN",
    label: "Search for an instrument",
    listLabel: "Results",
    listId: "story-list",
    open: true,
    activeId: "story-list-opt-0",
    waiting: false,
    stale: false,
    error: null,
    noResults: null,
    unavailable: null,
    skeleton: false,
    rows: [
      {
        key: "y:SYN",
        id: "story-list-opt-0",
        selected: true,
        busy: false,
        label: "SYN, Synthetic Co",
        content: {
          kind: "hit",
          symbol: "SYN",
          name: "Synthetic Co",
          tag: null,
          exchange: "GPW",
          type: "stock",
          mark: "add",
        },
        onMove() {},
        onPress() {},
      },
    ],
  },
};
