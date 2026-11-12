// The cash expense sheet: an amount typed on the keypad, a category, what it was and the day, added to
// the cash wallet of the wallet's currency (the base currency before the first expense). The category
// and the title start from the last cash expense; the sheet closes once the expense is saved.
import { addDays, type core, D, type IsoDate, Money } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { addCashExpense } from "@cashu/store/budget/commands";
import { useCommand, useQuery } from "@cashu/store-react";
import { applyKeypadKey, type CategoryOption, type KeypadKey, useUiEnv } from "@cashu/ui/native";
import { useState } from "react";
import { useServices } from "../../services/ServicesProvider";
import { categoryOptionsOf } from "../categories";
import { S } from "./Cash.strings";

/** The category of the first cash expense, when the wallet has none to copy. */
const DEFAULT_CATEGORY = "groceries";
/** The days the date control offers: today and the six before it. */
const DAYS = 7;

export interface CashSheetState {
  readonly amount: {
    /** The keypad text ("" before the first key; "." is the decimal point). */
    readonly text: string;
    /** The text as typed, in the locale and with the currency (shown while amounts are hidden). */
    readonly typed: string;
    /** The decimal key's face in the locale. */
    readonly decimal: string;
    readonly money: Money;
    onKey(key: KeypadKey): void;
  };
  readonly wallet: { readonly balance: Money; readonly exists: boolean };
  readonly grid: {
    readonly options: readonly CategoryOption[];
    readonly selected: string;
    readonly suggested: null;
    readonly expanded: boolean;
    onPick(key: string): void;
    onExpand(): void;
  };
  readonly title: {
    readonly value: string;
    onChange(value: string): void;
    readonly placeholder: string;
  };
  readonly date: {
    readonly options: readonly { readonly key: IsoDate; readonly label: string }[];
    readonly selected: IsoDate;
    onPick(key: IsoDate): void;
  };
  /** The primary button: "Add -PLN 45.00", or "Add expense" while amounts are hidden. */
  readonly addLabel: string;
  readonly canSave: boolean;
  readonly isSaving: boolean;
  readonly error: string | null;
  onSave(): void;
  onClose(): void;
}

const weekdays = new Map<string, Intl.DateTimeFormat>();
function weekday(date: IsoDate, locale: string): string {
  let format = weekdays.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    weekdays.set(locale, format);
  }
  return format.format(new Date(`${date}T12:00:00Z`));
}

function decimalOf(locale: string): string {
  // Through the i18n formatter: Hermes on iOS has no NumberFormat.formatToParts.
  const sample = formatDecimalValue(D("1.5"), locale, { fractionDigits: 1 }).text;
  return /\p{Nd}(\P{Nd}+)\p{Nd}/u.exec(sample)?.[1] ?? ".";
}

/** The keypad text as a number: a trailing "." is not a digit yet, and nothing typed is zero. */
function amountText(text: string): string {
  const plain = text.endsWith(".") ? text.slice(0, -1) : text;
  return plain === "" ? "0" : plain;
}

const REFUSALS: Readonly<Record<string, () => string>> = {
  invalid_amount: () => S.errorAmount,
  zero_amount: () => S.errorAmount,
  empty_title: () => S.errorTitle,
  unknown_category: () => S.errorCategory,
};

export function useCashSheet(args: {
  readonly today: IsoDate;
  readonly lang: core.UiLang;
  close(): void;
}): CashSheetState {
  const { locale, privacy } = useUiEnv();
  const { moneyQueries } = useServices();
  const wallet = useQuery(moneyQueries.cash.wallet, {});
  const categories = useQuery(moneyQueries.activity.categories, {
    today: args.today,
    lang: args.lang,
  });
  const options = categoryOptionsOf(categories.filter((c) => c.kind === "expense"));
  const last = wallet.transactions.find((row) => row.kind === "expense");
  const [text, setText] = useState("");
  const [category, setCategory] = useState(() =>
    last?.category && options.some((o) => o.key === last.category)
      ? last.category
      : DEFAULT_CATEGORY,
  );
  const [title, setTitle] = useState(() => last?.title ?? "");
  const [date, setDate] = useState<IsoDate>(args.today);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = useCommand(addCashExpense);

  const currency = wallet.currency;
  const number = amountText(text);
  const money = new Money(D(number), currency);
  const decimal = decimalOf(locale);
  const canSave = money.amount.gt(D("0")) && title.trim() !== "" && !add.isPending;

  const save = async () => {
    setError(null);
    const outcome = await add.run({
      amount: number,
      title,
      category,
      currency,
      onDate: date,
    });
    if (outcome.kind === "completed") return args.close();
    setError(
      outcome.kind === "refused"
        ? (REFUSALS[outcome.reason]?.() ?? S.couldNotSave)
        : S.couldNotSave,
    );
  };

  return {
    amount: {
      text,
      typed: S.typed((text === "" ? "0" : text).replace(".", decimal), currency),
      decimal,
      money,
      onKey: (key) => {
        setError(null);
        setText((prev) => applyKeypadKey(prev, key));
      },
    },
    wallet: { balance: new Money(wallet.balance, currency), exists: wallet.exists },
    grid: {
      options,
      selected: category,
      suggested: null,
      expanded,
      onPick: setCategory,
      onExpand: () => setExpanded(true),
    },
    title: { value: title, onChange: setTitle, placeholder: S.titlePlaceholder },
    date: {
      options: Array.from({ length: DAYS }, (_, back) => {
        const key = addDays(args.today, -back);
        return {
          key,
          label: back === 0 ? S.today : back === 1 ? S.yesterday : weekday(key, locale),
        };
      }),
      selected: date,
      onPick: setDate,
    },
    addLabel: privacy
      ? S.addExpense
      : S.add(formatDecimalValue(money.amount.neg(), locale, { currency, fractionDigits: 2 }).text),
    canSave,
    isSaving: add.isPending,
    error,
    onSave: () => void save(),
    onClose: args.close,
  };
}
