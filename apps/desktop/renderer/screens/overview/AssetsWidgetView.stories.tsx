import { D } from "@cashu/domain";
import { AssetsWidgetView, type AssetsWidgetViewProps } from "./AssetsWidgetView.js";

const state: AssetsWidgetViewProps["state"] = {
  rows: [
    {
      gid: "synthetic-asset",
      name: "Synthetic property",
      bank: "manual",
      type: "property",
      currency: "PLN",
      ibanTail: null,
      amount: D("350000"),
      asOf: "2026-09-30",
      liability: false,
      kind: "manual",
      note: null,
      depreciation: null,
    },
  ],
  displayRows: [
    {
      gid: "synthetic-asset",
      name: "Synthetic property",
      bank: "manual",
      type: "property",
      currency: "PLN",
      ibanTail: null,
      amount: D("350000"),
      asOf: "2026-09-30",
      liability: false,
      kind: "manual",
      note: null,
      depreciation: null,
      loss: null,
      lossLine: null,
      valuation: { text: "Synthetic valuation", stale: false },
    },
  ],
  widgetRows: [
    {
      gid: "synthetic-asset",
      name: "Synthetic property",
      note: null,
      value: "350,000 PLN",
      sub: { text: "Synthetic valuation", stale: false },
      lossLine: null,
    },
  ],
  totalsText: "350,000 PLN",
  drawerText: { title: "New position", tag: null, readOnlyValue: null, lastValuation: null },
  orderedTotals: [["PLN", D("350000")]],
  lossSummary: null,
  preview: null,
  positionTypes: [{ value: "property", label: "Synthetic property" }],
  vehicleLabel: "Synthetic vehicle",
  target: null,
  open: false,
  form: {
    name: "",
    type: "property",
    value: "",
    currency: "PLN",
    onDate: "2026-10-01",
    note: "",
    purchasePrice: "",
    purchaseDate: "2026-10-01",
    annualRate: "15",
    floor: "",
  },
  error: null,
  undone: null,
  busy: false,
  openNew: () => {},
  openEdit: () => {},
  close: () => {},
  set: () => {},
  submit: async () => {},
  remove: async () => {},
  undo: async () => {},
};
const args: AssetsWidgetViewProps = {
  state,
  today: "2026-10-01",
  baseCurrency: "PLN",
  privacy: false,
  onSetup: () => {},
};

export default { title: "Desktop/Overview/Assets", component: AssetsWidgetView, args };
export const Ready = {};
export const Empty = {
  args: {
    ...args,
    state: { ...state, rows: [], displayRows: [], widgetRows: [], orderedTotals: [] },
  },
};
export const Open = { args: { ...args, state: { ...state, open: true } } };
export const Privacy = { args: { ...args, privacy: true } };
