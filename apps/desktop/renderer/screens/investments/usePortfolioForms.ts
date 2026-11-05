import { D } from "@cashu/domain";
import { normalizeNumberInput } from "@cashu/i18n";
import {
  addUiManualTransaction,
  classifyUiInstrument,
  createUiBrokerageAccount,
  uiThesisCommands,
  updateUiWatchNote,
} from "@cashu/store/investments/screen";
import { WRAPPER } from "@cashu/ui-logic/investments/labels";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { I } from "./Portfolio.strings.js";

export const transactionTypes = [
  "buy",
  "sell",
  "dividend",
  "interest",
  "deposit",
  "withdrawal",
  "fee",
  "tax",
  "split",
  "transfer_in",
  "transfer_out",
  "adjustment",
  "fx_conversion",
] as const;
export const initialTransaction = (today: string) => ({
  account: "",
  type: "buy",
  tradeDate: today,
  instrument: "",
  symbol: "",
  isin: "",
  name: "",
  assetClass: "equity",
  currency: "",
  cashCurrency: "",
  quantity: "",
  price: "",
  grossAmount: "",
  fee: "",
  tax: "",
  cashAmount: "",
  fxRate: "",
  splitRatio: "",
  note: "",
});
export type TransactionDraft = ReturnType<typeof initialTransaction>;
const transactionAmounts = [
  "quantity",
  "price",
  "grossAmount",
  "fee",
  "tax",
  "cashAmount",
  "fxRate",
  "splitRatio",
] as const;
type AmountField = (typeof transactionAmounts)[number];

function fieldsForTransaction(type: string): readonly AmountField[] {
  if (type === "split") return ["splitRatio"];
  if (type === "transfer_out") return ["quantity"];
  if (type === "transfer_in" || type === "adjustment") return ["quantity", "price"];
  if (type === "fx_conversion") return ["cashAmount"];
  const fields: AmountField[] = ["grossAmount", "fee", "tax", "cashAmount", "fxRate"];
  if (type === "buy" || type === "sell") fields.unshift("quantity", "price");
  if (type === "dividend") fields.unshift("quantity");
  return fields;
}
export function canonicalInvestmentDecimal(value: string): string {
  const normalized = normalizeNumberInput(value);
  if (!/^-?\d*\.?\d+$/u.test(normalized)) throw new RangeError("invalid decimal");
  return D(normalized).format("f");
}
export function transactionInput(value: TransactionDraft, today: string) {
  if (value.tradeDate > today) throw new RangeError("future date");
  const instrumentForbidden = ["deposit", "withdrawal", "fx_conversion"].includes(value.type);
  const allowed = new Set(fieldsForTransaction(value.type));
  const neutral = ["split", "transfer_in", "transfer_out", "adjustment"].includes(value.type);
  return {
    account: value.account,
    type: value.type,
    tradeDate: value.tradeDate,
    instrument: instrumentForbidden ? null : value.instrument || null,
    ...(!instrumentForbidden && !value.instrument
      ? {
          described: {
            symbol: value.symbol || null,
            isin: value.isin || null,
            name: value.name || null,
            assetClass: value.assetClass,
            currency: value.currency || null,
          },
        }
      : {}),
    ...Object.fromEntries(
      transactionAmounts.flatMap((key) =>
        allowed.has(key) && value[key].trim()
          ? [[key, canonicalInvestmentDecimal(value[key])]]
          : [],
      ),
    ),
    currency: value.currency || null,
    ...(!neutral
      ? {
          cashCurrency:
            value.type === "fx_conversion" ? value.currency || null : value.cashCurrency || null,
        }
      : {}),
    note: value.note || null,
  };
}
const thesisCommands = uiThesisCommands();
export const thesisDefaults = {
  instrument: "",
  id: "",
  entryType: "trend",
  thesis: "",
  invalidation: "",
  exitPlan: "",
  sizePlan: "",
  reviewed: "no",
};
export const noteDefaults = { item: "", note: "", tags: "" };
export const classificationDefaults = {
  instrument: "",
  assetClass: "equity",
  valuationMode: "market",
  region: "",
  sector: "",
  name: "",
  status: "active",
  segment: "",
  tags: "",
  aliases: "",
};
function classificationInput(value: typeof classificationDefaults) {
  return classifyUiInstrument.input.parse({
    instrument: value.instrument,
    patch: {
      assetClass: value.assetClass,
      valuationMode: value.valuationMode,
      region: value.region,
      sector: value.sector,
      name: value.name,
      status: value.status,
      segment: value.segment || null,
      tags: value.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .map((tag) => tag.trim())
        .filter(Boolean),
      aliases: value.aliases
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf(":");
          return {
            namespace: index < 0 ? "" : line.slice(0, index),
            value: index < 0 ? "" : line.slice(index + 1),
          };
        }),
    },
  });
}
export const accountDefaults = { name: "", broker: "manual", wrapper: "regular", currency: "PLN" };
function accountInput(
  value: typeof accountDefaults,
  brokers: readonly { id: string; name: string }[],
) {
  const broker = brokers.find((row) => row.id === value.broker)?.name.split(" ")[0] ?? "";
  return {
    ...value,
    name: value.name.trim() || `${broker} ${WRAPPER[value.wrapper] ?? value.wrapper}`,
  };
}

export function usePortfolioForms(
  today: string,
  callbacks: {
    transaction(value: ReturnType<typeof transactionInput>): Promise<void>;
    account(value: typeof accountDefaults): Promise<void>;
    thesis(value: typeof thesisDefaults): Promise<void>;
    note(value: typeof noteDefaults): Promise<void>;
    classification(value: typeof classificationDefaults): Promise<void>;
  },
  brokers: readonly { id: string; name: string }[],
) {
  const [loaded, setLoaded] = useState(() => ({
    transaction: initialTransaction(today),
    account: accountDefaults,
    thesis: thesisDefaults,
    note: noteDefaults,
    classification: classificationDefaults,
  }));
  const transaction = useForm({
    defaultValues: loaded.transaction,
    validators: {
      onSubmit: ({ value }) => {
        try {
          return addUiManualTransaction.input.safeParse(transactionInput(value, today)).success
            ? undefined
            : I.invalid;
        } catch {
          return I.invalid;
        }
      },
    },
    onSubmit: ({ value }) => callbacks.transaction(transactionInput(value, today)),
  });
  const account = useForm({
    defaultValues: loaded.account,
    validators: {
      onSubmit: ({ value }) =>
        createUiBrokerageAccount.input.safeParse(accountInput(value, brokers)).success
          ? undefined
          : I.invalid,
    },
    onSubmit: ({ value }) => callbacks.account(accountInput(value, brokers)),
  });
  const thesis = useForm({
    defaultValues: loaded.thesis,
    validators: {
      onSubmit: ({ value }) => {
        const values = {
          entryType: value.entryType,
          thesis: value.thesis,
          invalidation: value.invalidation,
          exitPlan: value.exitPlan,
          sizePlan: value.sizePlan,
        };
        const checked = value.id
          ? thesisCommands.update.input.safeParse({
              id: value.id,
              values,
              reviewed: value.reviewed === "yes",
            })
          : thesisCommands.create.input.safeParse({ instrument: value.instrument, ...values });
        return checked.success ? undefined : I.invalid;
      },
    },
    onSubmit: ({ value }) => callbacks.thesis(value),
  });
  const note = useForm({
    defaultValues: loaded.note,
    validators: {
      onSubmit: ({ value }) =>
        updateUiWatchNote.input.safeParse({ ...value, tags: value.tags.split(",") }).success
          ? undefined
          : I.invalid,
    },
    onSubmit: ({ value }) => callbacks.note(value),
  });
  const classification = useForm({
    defaultValues: loaded.classification,
    validators: {
      onSubmit: ({ value }) => {
        try {
          classificationInput(value);
          return undefined;
        } catch {
          return I.invalid;
        }
      },
    },
    onSubmit: ({ value }) => callbacks.classification(value),
  });
  return {
    transaction,
    account,
    thesis,
    note,
    classification,
    loadTransaction(value: TransactionDraft) {
      setLoaded((old) => ({ ...old, transaction: value }));
      transaction.reset(value);
    },
    loadAccount(value: typeof accountDefaults) {
      setLoaded((old) => ({ ...old, account: value }));
      account.reset(value);
    },
    loadThesis(value: typeof thesisDefaults) {
      setLoaded((old) => ({ ...old, thesis: value }));
      thesis.reset(value);
    },
    loadNote(value: typeof noteDefaults) {
      setLoaded((old) => ({ ...old, note: value }));
      note.reset(value);
    },
    loadClassification(value: typeof classificationDefaults) {
      setLoaded((old) => ({ ...old, classification: value }));
      classification.reset(value);
    },
  };
}
