import { D, type Decimal, Money as MoneyValue } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { formatDecimalValue } from "@cashu/i18n/values";
import {
  addUiManualTransaction,
  classifyUiInstrument,
  createUiBrokerageAccount,
  type ImportPreviewDto,
  type InvestmentCommitResult,
  investmentDesktopQueries,
  investmentImportCommit,
  investmentImportPreview,
  investmentPreviewInputSchema,
  type PortfolioArgs,
  uiThesisCommands,
  updateUiWatchNote,
} from "@cashu/store/investments/screen";
import { useCommand, useQuery, useUiAction } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { txnType } from "@cashu/ui-logic/investments/labels";
import { weekChange } from "@cashu/ui-logic/investments/v2/logic";
import { useForm, useStore } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";
import { O } from "../CommandOutcome.strings.js";
import { commandFailure, type GuardedOutcome, useDurableCommands } from "../useDurableCommand.js";
import { I } from "./Portfolio.strings.js";
import {
  assetChartPresentation,
  investmentAllocationLabel,
  investmentCalendarDate,
  investmentMarks,
} from "./presentation.js";
import {
  accountDefaults,
  classificationDefaults,
  classificationInput,
  initialTransaction,
  noteDefaults,
  thesisDefaults,
  usePortfolioForms,
} from "./usePortfolioForms.js";

const queries = investmentDesktopQueries();
const thesisCommands = uiThesisCommands();
export type PortfolioDrawer =
  | "transaction"
  | "account"
  | "thesis"
  | "note"
  | "classification"
  | "import"
  | "transactions"
  | null;
export interface PortfolioScreenOptions {
  readonly today: string;
  readonly instrument?: string;
  readonly account?: string | null;
  readonly range?: string;
  readonly table?: boolean;
  openPage?(instrument: string): void;
  openAdjacent?(tab: string): void;
  onAccountPicked?(account: string | null): void;
  onRangePicked?(range: string): void;
  onTablePicked?(table: boolean): void;
}

export function usePortfolioScreen(options: PortfolioScreenOptions) {
  const { privacy, locale } = useUiEnv();
  const [localAccount, setLocalAccount] = useState<string | null>(null);
  const [localRange, setLocalRange] = useState("1y");
  const account = options.account === undefined ? localAccount : options.account;
  const range = options.range ?? localRange;
  const setAccount = (value: string | null) =>
    options.onAccountPicked ? options.onAccountPicked(value) : setLocalAccount(value);
  const setRange = (value: string) =>
    options.onRangePicked ? options.onRangePicked(value) : setLocalRange(value);
  const [selected, setSelected] = useState<string | null>(options.instrument ?? null);
  const [months, setMonths] = useState(24);
  const [tab, setTab] = useState<"positions" | "watch">("positions");
  const [sort, setSort] = useState<"value" | "result" | "week">("result");
  const [split, setSplit] = useState(false);
  const [allocationMode, setAllocationMode] = useState<
    "buckets" | "classes" | "regions" | "accounts"
  >("buckets");
  const [localTable, setLocalTable] = useState(false);
  const table = options.table ?? localTable;
  const setTable = (value: boolean) =>
    options.onTablePicked ? options.onTablePicked(value) : setLocalTable(value);
  const [drawer, setDrawer] = useState<PortfolioDrawer>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const args: PortfolioArgs = {
    today: options.today,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: lang(),
    account,
    range,
  };
  const portfolio = useQuery(queries.portfolio, args);
  const metadata = useQuery(queries.metadata, { lang: lang() });
  const asset = useQuery(queries.asset, { ...args, instrument: selected, months });
  const ledger = useQuery(queries.ledger, { instrument: selected, account });
  const transaction = useCommand(addUiManualTransaction);
  const addAccount = useCommand(createUiBrokerageAccount);
  const createThesis = useCommand(thesisCommands.create);
  const updateThesis = useCommand(thesisCommands.update);
  const watchNote = useCommand(updateUiWatchNote);
  const classify = useCommand(classifyUiInstrument);
  const durable = useDurableCommands();
  const previewAction = useUiAction(investmentImportPreview);
  const commitAction = useUiAction(investmentImportCommit);
  const [importPreview, setImportPreview] = useState<ImportPreviewDto | null>(null);
  const [importStage, setImportStage] = useState<string | null>(null);
  const [importOutcome, setImportOutcome] = useState<InvestmentCommitResult | null>(null);
  const [importUncertain, setImportUncertain] = useState(false);
  const [importStep, setImportStep] = useState(1);
  const [importDefaults, setImportDefaults] = useState({
    account: "",
    importer: "auto",
    mappingYaml: "",
    corrections: [] as string[],
  });
  const importForm = useForm({
    defaultValues: importDefaults,
    validators: {
      onSubmit: ({ value }) =>
        investmentPreviewInputSchema.safeParse({
          account: value.account,
          importer: value.importer,
          mappingYaml: value.mappingYaml || null,
        }).success
          ? undefined
          : I.invalid,
    },
    onSubmit: async ({ value }): Promise<void> => {
      if (submitting.current || privacy) return;
      if (importUncertain) {
        setError(I.importUnknown);
        return;
      }
      submitting.current = true;
      setError(null);
      setImportOutcome(null);
      setImportUncertain(false);
      try {
        const result = await previewAction.run(
          investmentPreviewInputSchema.parse({
            account: value.account,
            importer: value.importer,
            mappingYaml: value.mappingYaml || null,
          }),
        );
        if (!mounted.current) return;
        if (result.status !== "completed") {
          setError(result.status === "outcome_unknown" ? I.capability : I.errorCode(result.reason));
          return;
        }
        if (result.value.status === "cancelled") return;
        setImportPreview(result.value.preview);
        setImportStage(result.value.status === "previewed" ? result.value.stage : null);
        setImportStep(2);
        importForm.setFieldValue("corrections", []);
      } finally {
        submitting.current = false;
      }
    },
  });
  const importDraft = useStore(importForm.store, (form) => form.values);
  const commitPreview = async () => {
    if (importStage === null || submitting.current || privacy || importUncertain) return;
    submitting.current = true;
    setError(null);
    try {
      const result = await commitAction.run({
        stage: importStage,
        corrections: importDraft.corrections,
      });
      if (!mounted.current) return;
      if (result.status !== "completed") {
        if (result.status === "outcome_unknown") {
          setImportUncertain(true);
          setError(I.importUnknown);
        } else setError(I.errorCode(result.reason));
        return;
      }
      setImportOutcome(result.value);
      if (result.value.status === "committed") setImportStep(4);
      else setError(I.errorCode(result.value.reason));
    } finally {
      submitting.current = false;
    }
  };
  const busy =
    transaction.isPending ||
    addAccount.isPending ||
    createThesis.isPending ||
    updateThesis.isPending ||
    watchNote.isPending ||
    classify.isPending ||
    previewAction.isPending ||
    commitAction.isPending;
  const save = async <T>(run: () => Promise<GuardedOutcome<T>>, after?: (value: T) => void) => {
    if (submitting.current || privacy) return;
    submitting.current = true;
    setError(null);
    try {
      const result = await run();
      if (!mounted.current) return;
      if (result.kind !== "completed") {
        setError(result.kind === "refused" ? I.errorCode(result.reason) : commandFailure(result));
        return;
      }
      setDrawer(null);
      after?.(result.value);
    } finally {
      submitting.current = false;
    }
  };
  const forms = usePortfolioForms(
    options.today,
    {
      transaction: (value) =>
        save(
          () => durable.run("transaction", transaction, value),
          (value) => {
            if (value.warnings.length) setNotice(I.savedWarning);
          },
        ),
      account: (value) => save(() => durable.run("account", addAccount, value)),
      thesis: (value) => {
        const values = {
          entryType: value.entryType,
          thesis: value.thesis,
          invalidation: value.invalidation,
          exitPlan: value.exitPlan,
          sizePlan: value.sizePlan,
        };
        return value.id
          ? save(() =>
              durable.run("thesis", updateThesis, {
                id: value.id,
                values,
                reviewed: value.reviewed === "yes",
              }),
            )
          : save(() =>
              durable.run("thesis", createThesis, { instrument: value.instrument, ...values }),
            );
      },
      note: (value) =>
        save(() =>
          durable.run("note", watchNote, {
            item: value.item,
            note: value.note,
            tags: value.tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
          }),
        ),
      classification: (value) =>
        save(() => durable.run("classification", classify, classificationInput(value))),
    },
    metadata.brokers,
  );
  const transactionValues = useStore(forms.transaction.store, (state) => state.values);
  const base =
    portfolio.status === "ready"
      ? portfolio.positions.base_currency
      : (portfolio.accounts[0]?.currency ?? "PLN");
  const money = (amount: Decimal | string | null | undefined, currency = base) =>
    amount == null
      ? null
      : new MoneyValue(typeof amount === "string" ? D(amount) : amount, currency);
  const format = (value: number) =>
    formatDecimalValue(D(String(value)), locale, { fractionDigits: 2 }).text;
  const assetChart =
    asset.status === "ready"
      ? assetChartPresentation(
          asset,
          (value) => formatDecimalValue(value, locale, { currency: asset.chart.currency }).text,
          privacy,
          typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches,
        )
      : null;
  const protectDraft = () => {
    if (["transaction", "account", "thesis", "note", "classification"].some(durable.uncertain)) {
      setError(O.unknown);
      return true;
    }
    if (importUncertain) {
      setError(I.importUnknown);
      return true;
    }
    return false;
  };
  const close = () => {
    if (!protectDraft() && !busy) {
      setDrawer(null);
      setError(null);
    }
  };
  const openImport = (selectedAccount?: string) => {
    if (protectDraft()) return;
    const values = {
      account: selectedAccount ?? account ?? portfolio.accounts[0]?.gid ?? "",
      importer: "auto",
      mappingYaml: "",
      corrections: [] as string[],
    };
    setImportDefaults(values);
    importForm.reset(values);
    setImportPreview(null);
    setImportStage(null);
    setImportOutcome(null);
    setImportUncertain(false);
    setImportStep(1);
    setError(null);
    setDrawer("import");
  };
  const openTransaction = (instrument = selected) => {
    if (protectDraft()) return;
    const selectedAccount =
      portfolio.accounts.find((row) => row.gid === account) ?? portfolio.accounts[0];
    forms.loadTransaction({
      ...initialTransaction(options.today),
      account: selectedAccount?.gid ?? "",
      currency:
        asset.status === "ready"
          ? asset.detail.instrument.currency
          : (selectedAccount?.currency ?? base),
      cashCurrency: selectedAccount?.currency ?? base,
      instrument: instrument ?? "",
    });
    setError(null);
    setDrawer("transaction");
  };
  const openAccount = () => {
    if (protectDraft()) return;
    forms.loadAccount({ ...accountDefaults, currency: base });
    setError(null);
    setDrawer("account");
  };
  const openThesis = (id: string | null) => {
    if (protectDraft()) return;
    if (asset.status !== "ready") return;
    const row = asset.detail.theses.find((row) => row.id === id);
    forms.loadThesis(
      row
        ? {
            instrument: asset.detail.instrument.id,
            id: row.id,
            entryType: row.entry_type,
            thesis: row.thesis,
            invalidation: row.invalidation ?? "",
            exitPlan: row.exit_plan ?? "",
            sizePlan: row.size_plan ?? "",
            reviewed: "no",
          }
        : { ...thesisDefaults, instrument: asset.detail.instrument.id },
    );
    setError(null);
    setDrawer("thesis");
  };
  const openNote = () => {
    if (protectDraft()) return;
    if (asset.status !== "ready" || portfolio.status !== "ready") return;
    const row = portfolio.watch.find((row) => row.instrument_id === selected);
    if (!row) return;
    forms.loadNote({
      ...noteDefaults,
      item: row.id,
      note: row.note ?? "",
      tags: row.tags.join(", "),
    });
    setError(null);
    setDrawer("note");
  };
  const openClassification = (id: string) => {
    if (protectDraft()) return;
    if (portfolio.status !== "ready") return;
    const instrument =
      portfolio.positions.positions.find((row) => row.instrument.id === id)?.instrument ??
      (asset.status === "ready" ? asset.detail.instrument : null);
    if (!instrument) return;
    forms.loadClassification({
      ...classificationDefaults,
      instrument: id,
      assetClass: instrument.asset_class,
      valuationMode: instrument.valuation_mode,
      name: instrument.name ?? "",
      region: instrument.region ?? "",
      sector: instrument.sector ?? "",
      status: instrument.status,
      segment: instrument.segment ?? "",
      tags: instrument.tags.join(", "),
    });
    setError(null);
    setDrawer("classification");
  };
  const rows =
    portfolio.status === "ready"
      ? [...portfolio.positions.positions].sort((left, right) => {
          const key = (row: typeof left) =>
            sort === "value"
              ? (row.value?.toFloat() ?? -Infinity)
              : sort === "result"
                ? (row.unrealized_pct ?? -Infinity)
                : (weekChange(
                    row.closes_30d.map((point) => ({ ...point, close: point.close.toFloat() })),
                  ) ?? -Infinity);
          return key(right) - key(left);
        })
      : [];
  return {
    transactionTypeLabel: txnType,
    marksFor: investmentMarks,
    calendarDate: investmentCalendarDate,
    allocationLabel: investmentAllocationLabel,
    portfolio,
    asset,
    assetChart,
    ledger,
    brokers: metadata.brokers,
    instrumentOptions: metadata.instruments,
    importAvailable: metadata.importAvailable,
    importForm,
    importDraft,
    importPreview,
    importOutcome,
    importUncertain,
    importStep,
    setImportStep,
    commitPreview,
    openImport,
    base,
    money,
    format,
    rows,
    account,
    setAccount,
    range,
    setRange,
    selected,
    setSelected,
    months,
    setMonths,
    tab,
    setTab,
    sort,
    setSort,
    split,
    setSplit,
    allocationMode,
    setAllocationMode,
    table,
    setTable,
    drawer,
    setDrawer: (next: PortfolioDrawer) => {
      if (!protectDraft()) setDrawer(next);
    },
    error,
    notice,
    busy,
    privacy,
    forms,
    transactionValues,
    close,
    openTransaction,
    openAccount,
    openThesis,
    openNote,
    openClassification,
    openPage: () => {
      if (selected) options.openPage?.(selected);
    },
    adjacent: (tab: string) => {
      if (options.openAdjacent) options.openAdjacent(tab);
      else setNotice(I.capability);
    },
    isPage: options.instrument !== undefined,
  };
}
export type PortfolioScreenState = ReturnType<typeof usePortfolioScreen>;
