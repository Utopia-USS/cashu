import { budget, D, type IsoDate, Money } from "@cashu/domain";
import { intlLocale, lang } from "@cashu/i18n";
import { formatDecimalValue } from "@cashu/i18n/values";
import { setCushion, setTransactionCategory } from "@cashu/store";
import {
  budgetDesktopQueries,
  budgetScreenCashflow,
  budgetScreenCurrencies,
  budgetScreenSpending,
  setDesktopMerchantCategory,
  type UncategorizedMerchant,
} from "@cashu/store/budget/queries";
import { useCommand, useQuery } from "@cashu/store-react";
import { type SeriesColor, useUiEnv } from "@cashu/ui";
import { useEffect, useState } from "react";
import { O } from "../CommandOutcome.strings.js";
import { commandFailure, useDurableCommands } from "../useDurableCommand.js";
import { B } from "./Budget.strings.js";
import { type CushionFormValues, useCushionForm } from "./useCushionForm.js";

const queries = budgetDesktopQueries();
export type BudgetTab = "expenses" | "flows" | "subs";
export interface BudgetFilters {
  currency?: string;
  mode?: "month" | "quarter" | "year" | "all";
  anchor?: number;
  gran?: "monthly" | "quarterly" | "yearly";
  range?: number;
  month?: string;
  drill?: string;
  sort?: "date" | "amount";
  order?: "asc" | "desc";
}

export function useBudgetScreen(args: {
  today: IsoDate;
  tab: BudgetTab;
  filters: BudgetFilters;
  change(filters: BudgetFilters): void;
}) {
  const { privacy } = useUiEnv();
  const f = args.filters;
  const currencies = useQuery(budgetScreenCurrencies, { today: args.today });
  const codes = currencies.currencies.map((c) => c.currency);
  const currency =
    f.currency && codes.includes(f.currency)
      ? f.currency
      : codes.includes(currencies.baseCurrency) || codes.length === 0
        ? currencies.baseCurrency
        : (codes[0] ?? currencies.baseCurrency);
  const flow = useQuery(budgetScreenCashflow, { today: args.today, currency, period: {} });
  const months = flow.rows
    .slice(-240)
    .map((row) => Number(row.label.slice(0, 4)) * 12 + Number(row.label.slice(5)) - 1);
  const min = months[0] ?? 0;
  const max = months.at(-1) ?? min;
  const mode = f.mode ?? "month";
  const scale = mode === "year" ? 12 : mode === "quarter" ? 3 : 1;
  const first = Math.floor(min / scale);
  const last = Math.floor(max / scale);
  const anchor = Math.max(first, Math.min(last, f.anchor ?? last));
  const ym = anchor * scale;
  const period: { year?: number; month?: number; quarter?: number } =
    mode === "all" || months.length === 0
      ? {}
      : {
          year: Math.floor(ym / 12),
          ...(mode === "month"
            ? { month: (ym % 12) + 1 }
            : mode === "quarter"
              ? { quarter: Math.floor((ym % 12) / 3) + 1 }
              : {}),
        };
  const spending = useQuery(budgetScreenSpending, {
    today: args.today,
    currency,
    period,
    lang: lang(),
  });
  const drill = useQuery(queries.drill, {
    category: f.drill ?? "",
    currency,
    period,
    sort: f.sort ?? "date",
    order: f.order ?? "desc",
  });
  const subscriptions = useQuery(queries.subscriptions);
  const close = useQuery(queries.monthClose, {
    today: args.today,
    month: f.month ?? null,
    lang: lang(),
  });
  const settings = useQuery(queries.settings);
  const unassigned = useQuery(queries.uncategorized, { currency });
  const categoryCommand = useCommand(setTransactionCategory);
  const merchantCommand = useCommand(setDesktopMerchantCategory);
  const cushionCommand = useCommand(setCushion);
  const durable = useDurableCommands();
  const [message, setMessage] = useState<string | null>(null);
  const [offer, setOffer] = useState<{
    merchantKey: string;
    category: string;
    label: string;
    context: string;
  } | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [categoryRows, setCategoryRows] = useState<readonly UncategorizedMerchant[]>([]);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [cushionOpen, setCushionOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [restOpen, setRestOpen] = useState(false);
  const [allCategories, setAllCategories] = useState(false);
  const offerContext = `${currency}:${mode}:${anchor}:${f.drill ?? ""}`;
  useEffect(() => {
    if (message === null || message === O.unknown) return;
    const timer = setTimeout(() => {
      setMessage(null);
      setOffer(null);
    }, 9000);
    return () => clearTimeout(timer);
  }, [message]);
  const patch = (values: Partial<BudgetFilters>) => args.change({ ...f, ...values });
  const rule = settings.settings?.cushion;
  const [cushionDefaults, setCushionDefaults] = useState<CushionFormValues>({
    targetMode: "amount",
    enabled: false,
    currency,
    targetAmount: "",
    targetMonths: null,
    accounts: [],
    monthlyMax: "",
  });
  const form = useCushionForm(
    currency,
    async (value) => {
      const result = await durable.run("cushion", cushionCommand, {
        ...value,
        targetAmount:
          value.targetMode === "amount"
            ? value.targetAmount.replace(/\s/g, "").replace(",", ".")
            : "",
        targetMonths: value.targetMode === "months" ? value.targetMonths : null,
        monthlyMax: value.monthlyMax.replace(/\s/g, "").replace(",", "."),
      });
      if (result.kind === "completed") {
        setCushionOpen(false);
        setMessage(B.saved);
      } else setMessage(commandFailure(result, B.refused));
    },
    cushionDefaults,
  );
  const openCushion = () => {
    if (durable.uncertain("cushion")) {
      setMessage(O.unknown);
      setCushionOpen(true);
      return;
    }
    if (!rule) {
      setMessage(B.unsupported);
      return;
    }
    const next: CushionFormValues = {
      targetMode: rule.targetAmount !== null ? "amount" : "months",
      enabled: rule.enabled,
      currency: rule.currency ?? currencies.baseCurrency,
      targetAmount: rule.targetAmount?.toString() ?? "",
      targetMonths: rule.targetMonths,
      accounts: [...rule.accountIds],
      monthlyMax: rule.monthlyMax?.toString() ?? "",
    };
    setCushionDefaults(next);
    form.reset(next);
    setMessage(null);
    setCushionOpen(true);
  };
  const categories = budget.CATEGORIES.map((c) => ({
    key: c.key,
    label: budget.categoryLabel(c.key, lang()),
    kind: c.kind,
  }));
  const markCategory = async (txn: string, category: string) => {
    const row = drill.find((item) => item.key === txn);
    if (!row) return;
    const result = await durable.run(`category:${txn}`, categoryCommand, { txn, category });
    if (result.kind !== "completed") {
      setMessage(commandFailure(result, B.refused));
      return;
    }
    setMessage(B.saved);
    setOffer(
      category !== "cash_withdrawal" && row.merchantKey
        ? {
            merchantKey: row.merchantKey,
            category,
            label: row.counterparty || row.merchant || row.merchantKey,
            context: offerContext,
          }
        : null,
    );
  };
  const markMerchant = async (merchantKey: string, category: string) => {
    const result = await durable.run(`merchant:${merchantKey}`, merchantCommand, {
      merchantKey,
      category,
    });
    if (result.kind === "completed") {
      setMessage(B.updated(result.value.updated));
      setSaved((prev) => ({ ...prev, [merchantKey]: category }));
      setOffer(null);
    } else setMessage(commandFailure(result, B.refused));
  };
  const total = spending.total;
  const small = spending.rows.filter(
    (row) => !total.isZero() && Math.round(row.amount.div(total).mul(D("100")).toFloat()) <= 1,
  );
  const collapsed = small.length >= 2;
  const display = collapsed
    ? [
        ...spending.rows.filter((row) => !small.includes(row)),
        {
          category: "__rest__",
          label: B.rest,
          amount: small.reduce((sum, row) => sum.add(row.amount), D("0")),
        },
      ]
    : [...spending.rows];
  const selectSlice = (index: number) => {
    const row = display[index];
    if (!row) return;
    if (row.category === "__rest__") setRestOpen(!restOpen);
    else patch({ drill: row.category });
  };
  const gran = f.gran ?? "monthly";
  const grouped = new Map<
    string,
    {
      label: string;
      income: ReturnType<typeof D>;
      expense: ReturnType<typeof D>;
      net: ReturnType<typeof D>;
    }
  >();
  for (const row of flow.rows.slice(-240)) {
    const label =
      gran === "yearly"
        ? row.label.slice(0, 4)
        : gran === "quarterly"
          ? `${row.label.slice(0, 4)} Q${Math.floor((Number(row.label.slice(5)) - 1) / 3) + 1}`
          : row.label;
    const prev = grouped.get(label);
    grouped.set(label, {
      label,
      income: (prev?.income ?? D("0")).add(row.income),
      expense: (prev?.expense ?? D("0")).add(row.expense),
      net: (prev?.net ?? D("0")).add(row.net),
    });
  }
  const range = f.range ?? (gran === "monthly" ? 12 : gran === "quarterly" ? 8 : 0);
  const flowRows = [...grouped.values()].slice(range === 0 ? 0 : -range);
  const format = (value: ReturnType<typeof D>) =>
    privacy ? "•••" : formatDecimalValue(value, intlLocale(), { currency }).text;
  const flowTip = (index: number) => {
    const row = flowRows[index];
    return {
      title: row?.label ?? "",
      rows: row
        ? [
            { name: B.income, value: format(row.income), amount: true },
            { name: B.expense, value: format(row.expense), amount: true },
            { name: B.net, value: format(row.net), amount: true },
          ]
        : [],
    };
  };
  return {
    tab: args.tab,
    privacy,
    today: args.today,
    currency,
    codes,
    mode,
    anchor,
    first,
    last,
    periodLabel:
      mode === "all"
        ? B.all
        : mode === "year"
          ? String(period.year ?? "")
          : mode === "quarter"
            ? `${period.year} Q${period.quarter}`
            : `${period.year ?? ""}-${String(period.month ?? "").padStart(2, "0")}`,
    patch,
    switchMode: (next: NonNullable<BudgetFilters["mode"]>) => {
      const nextScale = next === "year" ? 12 : next === "quarter" ? 3 : 1;
      patch({ mode: next, anchor: Math.floor(ym / nextScale) });
    },
    display,
    small,
    collapsed,
    restOpen,
    selectSlice,
    segments: display.map((row, i) => ({
      name: row.label,
      value: row.amount.toFloat(),
      color: ((i % 8) + 1) as SeriesColor,
    })),
    total: new Money(total, currency),
    spending: spending.rows,
    drill,
    drillCategory: f.drill ?? null,
    sort: f.sort ?? "date",
    order: f.order ?? "desc",
    categories,
    markCategory,
    markMerchant,
    offer: offer?.context === offerContext ? offer : null,
    message,
    setMessage,
    busy: categoryCommand.isPending || merchantCommand.isPending || cushionCommand.isPending,
    categoriesOpen,
    categoryRows,
    saved,
    openCategories: () => {
      if (durable.anyUncertain()) {
        setMessage(O.unknown);
        return;
      }
      setCategoryRows(unassigned);
      setSaved({});
      setCategoriesOpen(true);
      setMessage(null);
    },
    closeCategories: () => {
      if (durable.anyUncertain()) setMessage(O.unknown);
      else setCategoriesOpen(false);
    },
    shiftClose: (delta: number) => {
      if (!close.close) return;
      const [year, month] = close.close.month.split("-").map(Number);
      const date = new Date(Date.UTC(year ?? 2000, (month ?? 1) - 1 + delta, 1));
      patch({ month: date.toISOString().slice(0, 7) });
    },
    subscriptions,
    close: close.close,
    strategyUnavailable: close.strategyUnavailable,
    settingsUnavailable: close.settingsUnavailable,
    form,
    cushionOpen,
    openCushion,
    closeCushion: () => {
      if (durable.uncertain("cushion")) setMessage(O.unknown);
      else setCushionOpen(false);
    },
    accounts: settings.accounts,
    importOpen,
    setImportOpen,
    allCategories,
    setAllCategories,
    gran,
    ranges:
      gran === "monthly" ? [6, 12, 24, 0] : gran === "quarterly" ? [4, 8, 12, 0] : [3, 5, 10, 0],
    range,
    flowRows,
    flowTip,
    flowSummary: flowRows
      .map((_, i) => {
        const tip = flowTip(i);
        return `${tip.title}: ${tip.rows.map((row) => `${row.name} ${row.value}`).join(", ")}`;
      })
      .join("; "),
  };
}
export type BudgetScreenState = ReturnType<typeof useBudgetScreen>;
