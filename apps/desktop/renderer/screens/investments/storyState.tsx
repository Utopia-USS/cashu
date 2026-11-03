import { D, type Decimal, Money as MoneyValue } from "@cashu/domain";
import { asInstrumentId, toCurrency } from "@cashu/domain/investments";
import { intlLocale } from "@cashu/i18n";
import type { AssetSnapshot, PortfolioSnapshot } from "@cashu/store/investments/screen";
import { UiEnvProvider } from "@cashu/ui";
import { txnType } from "@cashu/ui-logic/investments/labels";
import { useForm, useStore } from "@tanstack/react-form";
import type { ComponentType } from "react";
import {
  investmentAllocationLabel,
  investmentCalendarDate,
  investmentMarks,
} from "./presentation.js";
import { usePortfolioForms } from "./usePortfolioForms.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";

const instrument = {
  id: asInstrumentId("a".repeat(32)),
  label: "Synthetic fund",
  name: "Synthetic fund",
  symbol: "SYN",
  currency: toCurrency("PLN"),
  asset_class: "equity",
  valuation_mode: "market",
  status: "active",
  region: "global",
  sector: null,
  isin: null,
  mic: null,
  tags: [],
  segment: null,
  needs_classification: false,
};
const account = {
  gid: "b".repeat(32),
  id: "b".repeat(32),
  name: "Synthetic brokerage",
  currency: "PLN",
  bank: "manual",
  broker_name: "Manual",
  wrapper: "regular",
  snapshot_date: "2026-10-01",
  value: D("1200"),
  share: 1,
};
const position = {
  instrument,
  value: D("1200"),
  cost: D("1000"),
  unrealized: D("200"),
  unrealized_pct: 0.2,
  quantity: D("10"),
  price: D("120"),
  price_date: "2026-10-01",
  weight: 1,
  accounts: [],
  lots: [],
  hints: [],
  dividends: {},
  closes_30d: [{ date: "2026-10-01", close: D("120") }],
  open_signals: 0,
};
/** Synthetic visual fixture only; generated-demo Electron proves the actual data path separately. */
export const readyPortfolio = {
  status: "ready",
  accounts: [account],
  positions: { base_currency: "PLN", total: D("1200"), positions: [position], cash: [] },
  watch: [],
  accountViews: [account],
  allocation: {
    buckets: [],
    by_asset_class: [{ key: "equity", value: D("1200"), weight: 1 }],
    by_region: [{ key: "global", value: D("1200"), weight: 1 }],
  },
  overview: {
    kpis: {
      value: { total: D("1200") },
      cash: { amount: D("0") },
      unrealized: { amount: D("200"), cost: D("1000") },
    },
    freshness: { prices: { stale_count: 0 }, fx: { missing: [] } },
    warnings: [],
  },
  performance: { summary: null, points: [], benchmark: { status: "no_benchmark" } },
  contributions: [],
  contributionPlan: null,
  strategy: { state: "missing", issues: [], inactiveRules: [] },
} as unknown as PortfolioSnapshot;
export const readyAsset = {
  status: "ready",
  detail: {
    instrument,
    entry: { state: "held", watch_item_id: null },
    position,
    theses: [],
    transactions: [],
    hints: [],
  },
  chart: {
    series: [
      { date: "2026-09-01", close: D("100") },
      { date: "2026-10-01", close: D("120") },
    ],
    currency: "PLN",
    markers: [],
    thresholds: [],
    cost: null,
    last: { date: "2026-10-01", close: D("120") },
  },
  quoteFacts: { fromHigh: -0.02, rangeLow: D("100"), volatility30: null },
  lotFacts: { rows: [], multiAccount: false },
  fees: [],
} as unknown as AssetSnapshot;

export function StoryFixture({
  component: Component,
  state: override = {},
}: {
  component: ComponentType<{ state: PortfolioScreenState }>;
  state?: Partial<PortfolioScreenState>;
}) {
  const nothing = async () => {};
  const forms = usePortfolioForms(
    "2026-10-01",
    {
      transaction: nothing,
      account: nothing,
      thesis: nothing,
      note: nothing,
      classification: nothing,
    },
    [{ id: "manual", name: "Manual" }],
  );
  const transactionValues = useStore(forms.transaction.store, (state) => state.values);
  const importForm = useForm({
    defaultValues: { account: "", importer: "auto", mappingYaml: "", corrections: [] as string[] },
  });
  const money = (value: Decimal | string | null | undefined, currency = "PLN") =>
    value == null ? null : new MoneyValue(typeof value === "string" ? D(value) : value, currency);
  const state: PortfolioScreenState = {
    transactionTypeLabel: txnType,
    marksFor: investmentMarks,
    calendarDate: investmentCalendarDate,
    allocationLabel: investmentAllocationLabel,
    portfolio: readyPortfolio,
    asset: readyAsset,
    assetChart: null,
    ledger: { ok: true, rows: [] },
    importAvailable: false,
    importForm: importForm as unknown as PortfolioScreenState["importForm"],
    importDraft: { account: "", importer: "auto", mappingYaml: "", corrections: [] },
    importPreview: null,
    importOutcome: null,
    importUncertain: false,
    importStep: 1,
    setImportStep() {},
    async commitPreview() {},
    openImport() {},
    brokers: [{ id: "manual", name: "Manual" }],
    instrumentOptions: [instrument],
    base: "PLN",
    money,
    format: (value) => String(value),
    rows: readyPortfolio.status === "ready" ? readyPortfolio.positions.positions : [],
    account: null,
    setAccount() {},
    range: "1y",
    setRange() {},
    selected: null,
    setSelected() {},
    months: 24,
    setMonths() {},
    tab: "positions",
    setTab() {},
    sort: "result",
    setSort() {},
    split: false,
    setSplit() {},
    allocationMode: "classes",
    setAllocationMode() {},
    table: false,
    setTable() {},
    drawer: null,
    setDrawer() {},
    error: null,
    notice: null,
    busy: false,
    privacy: false,
    forms,
    transactionValues,
    close() {},
    openTransaction() {},
    openAccount() {},
    openThesis() {},
    openNote() {},
    openClassification() {},
    openPage() {},
    adjacent() {},
    isPage: false,
    ...override,
  };
  return (
    <UiEnvProvider locale={intlLocale()} privacy={state.privacy}>
      <Component state={state} />
    </UiEnvProvider>
  );
}
