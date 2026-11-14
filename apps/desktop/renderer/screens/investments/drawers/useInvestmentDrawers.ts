// The investments drawers of the old Home (ab24ab6 modules/investments/Drawers.tsx): the manual transaction,
// the brokerage account, the thesis and an instrument's transactions. Each hook keeps the old drawer's own
// state and checks (ui-logic TXN_RULES / validateTxn / txnCash, verbatim), runs the native command and hands the
// pure View formatted rows. Inputs are the old shapes (legacy ids from home/legacyWire); gidOf() turns them back
// into the gids the commands take.
import { D, type Decimal } from "@cashu/domain";
import { normalizeNumberInput } from "@cashu/i18n";
import { S } from "@cashu/i18n/investments/Drawers.strings";
import {
  addUiManualTransaction,
  createUiBrokerageAccount,
  investmentDesktopQueries,
  uiThesisCommands,
} from "@cashu/store/investments/screen";
import { useCommand, useQuery } from "@cashu/store-react";
import { label } from "@cashu/ui-logic/core/messages";
import {
  accountLabel,
  ENTRY_TYPE,
  money,
  numInput,
  parseNum,
  plainMoney,
  qty,
  TXN_TYPE,
  txnType,
  unitPrice,
  WRAPPER,
} from "@cashu/ui-logic/investments/labels";
import { TXN_RULES, txnCash, validateTxn } from "@cashu/ui-logic/investments/logic";
import type { AccountRow, Position, Thesis } from "@cashu/ui-logic/investments/types";
import { useState } from "react";
import { commandFailure, useDurableCommands } from "../../useDurableCommand.js";
import { gidOf } from "../home/legacyWire.js";

const thesisCommands = uiThesisCommands();
const ledgerQuery = investmentDesktopQueries().ledger;

/** A native refusal reason as the old error text (core/messages error labels), else the reason itself. */
const reasonText = (reason: string) => label(`error.${reason}`) ?? reason;

/** The typed text as the exact decimal string a command takes; null when empty or not a number. */
const decimalOf = (text: string): string | null => {
  const t = normalizeNumberInput(text);
  return t && /^-?\d*\.?\d+$/.test(t) ? D(t).format("f") : null;
};

// ---- manual transaction ------------------------------------------------------------------

const TYPES = [
  "buy",
  "sell",
  "deposit",
  "withdrawal",
  "dividend",
  "interest",
  "fee",
  "tax",
  "transfer_in",
  "transfer_out",
  "adjustment",
  "split",
];

interface TxnPreset {
  instrumentId?: number | string | null;
  type?: string;
  accountId?: number | null;
}

export interface TxnDrawerInput {
  accounts: readonly AccountRow[];
  positions: readonly Position[];
  preset: TxnPreset | null;
  /** The calendar day (the date field's default and maximum). */
  today: string;
  onClose(): void;
  /** Saved: the warnings of the stored row (texts), as the old `r.warnings`. */
  onSaved(warnings: string[]): void;
}

/** Mounted while the drawer is open, so every opening starts from its preset. */
export function useTxnDrawer(input: TxnDrawerInput) {
  const { accounts, positions, preset, today } = input;
  const presetPos = positions.find(
    (p) => String(p.instrument.id) === String(preset?.instrumentId ?? ""),
  );
  const [acc, setAcc] = useState<number | null>(
    preset?.accountId ?? presetPos?.accounts[0]?.account_id ?? accounts[0]?.id ?? null,
  );
  const [type, setType] = useState(
    preset?.type ?? (presetPos ? "buy" : positions.length ? "buy" : "deposit"),
  );
  const [date, setDate] = useState(today);
  const [instId, setInstId] = useState<string>(
    presetPos ? String(presetPos.instrument.id) : positions.length ? "" : "__new",
  );
  const [symbol, setSymbol] = useState("");
  const [isin, setIsin] = useState("");
  const [name, setName] = useState("");
  const [q, setQ] = useState("");
  const [price, setPrice] = useState(presetPos ? numInput(presetPos.price) : "");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("");
  const [split, setSplit] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [curPick, setCurPick] = useState<string | null>(null);
  const [fx, setFx] = useState("");
  const durable = useDurableCommands();
  const add = useCommand(addUiManualTransaction);
  const [busy, setBusy] = useState(false);

  const account = accounts.find((a) => a.id === acc) ?? null;
  const rule = TXN_RULES[type] ?? TXN_RULES.buy;
  const isNew = instId === "__new";
  const pos = positions.find((p) => String(p.instrument.id) === instId) ?? null;
  const accCur = account?.currency ?? "PLN";
  const known = pos?.price_currency ?? pos?.instrument.currency ?? null;
  const currency = curPick ?? known ?? accCur;
  const cross = rule?.sign !== "neutral" && currency !== accCur;
  const fxNum = parseNum(fx);
  const values = {
    type,
    hasInstrument:
      rule?.instrument !== "none" && (isNew ? !!(symbol.trim() || isin.trim()) : !!instId),
    quantity: parseNum(q),
    price: parseNum(price),
    amount: parseNum(amount),
    fee: parseNum(fee),
    split: parseNum(split),
    date,
  };
  const errors = validateTxn(values, today);
  if (cross && !(fxNum != null && fxNum > 0)) errors.fx = S.fxRequired(accCur, currency);
  const rawCash = txnCash(values);
  const cash = rawCash == null ? null : cross ? (fxNum ? rawCash * fxNum : null) : rawCash;
  const fe = (k: string) => (touched && errors[k] ? errors[k] : null);

  const save = async () => {
    setTouched(true);
    if (Object.keys(errors).length || acc == null || !rule) return;
    const accountGid = gidOf(acc);
    if (accountGid === null) return;
    setBusy(true);
    setErr(null);
    try {
      const withInstrument = rule.instrument !== "none";
      const r = await durable.run("txn", add, {
        account: accountGid,
        type,
        tradeDate: date,
        instrument: withInstrument && instId && !isNew ? gidOf(pos?.instrument.id ?? instId) : null,
        described:
          withInstrument && isNew && (symbol.trim() || isin.trim())
            ? {
                symbol: symbol.trim() || null,
                isin: isin.trim().toUpperCase() || null,
                name: name.trim() || null,
                currency,
              }
            : null,
        quantity: rule.quantity !== "none" ? decimalOf(q) : null,
        price: rule.price !== "none" ? decimalOf(price) : null,
        grossAmount: rule.amount !== "none" ? decimalOf(amount) : null,
        fee: decimalOf(fee),
        splitRatio: rule.split ? decimalOf(split) : null,
        currency,
        note: note.trim() || null,
        ...(cross ? { cashCurrency: accCur, fxRate: decimalOf(fx) } : {}),
      });
      if (r.kind === "completed")
        input.onSaved(r.value.warnings.map((w) => label(`warning.${w.code}`, w.params) ?? w.code));
      else setErr(r.kind === "refused" ? reasonText(r.reason) : commandFailure(r));
    } finally {
      setBusy(false);
    }
  };

  const instrumentOptions = [
    { value: "", label: rule?.instrument === "optional" ? S.noInstrument : S.choose },
    ...positions.map((p) => ({
      value: String(p.instrument.id),
      label: `${p.instrument.label}${p.instrument.symbol && p.instrument.symbol !== p.instrument.label ? ` (${p.instrument.symbol})` : ""}`,
    })),
    { value: "__new", label: S.newInstrumentOpt },
  ];
  return {
    accountTag: account ? accountLabel(account, [...accounts]) : null,
    error: err ? S.notSaved(err) : null,
    footHint:
      cash != null && cash !== 0
        ? S.cashEffect(plainMoney(cash, cross ? accCur : currency, true))
        : rule?.sign === "neutral"
          ? S.noCashEffect
          : "",
    busy,
    saveDisabled: busy || acc == null,
    onClose: input.onClose,
    onSave: save,
    account: acc == null ? "" : String(acc),
    accountOptions: accounts.map((a) => ({
      value: String(a.id),
      label: accountLabel(a, [...accounts]),
    })),
    onAccount: (v: string) => setAcc(Number(v)),
    type,
    typeOptions: TYPES.map((t) => ({ value: t, label: TXN_TYPE[t] ?? t })),
    onType: setType,
    date,
    today,
    onDate: setDate,
    dateError: fe("date"),
    instrument:
      rule?.instrument !== "none"
        ? {
            label: `${S.colInstrument}${rule?.instrument === "optional" ? S.optional : ""}`,
            value: instId,
            options: instrumentOptions,
            onChange: setInstId,
            error: fe("instrument"),
          }
        : null,
    newInstrument:
      rule?.instrument !== "none" && isNew
        ? { symbol, onSymbol: setSymbol, isin, onIsin: setIsin, name, onName: setName }
        : null,
    quantity:
      rule?.quantity !== "none"
        ? {
            label: `${S.colQty}${rule?.quantity === "optional" ? S.optional : ""}`,
            value: q,
            onChange: setQ,
            error: fe("quantity"),
          }
        : null,
    price:
      rule?.price !== "none"
        ? { label: S.price(currency), value: price, onChange: setPrice, error: fe("price") }
        : null,
    amount:
      rule?.amount !== "none"
        ? { label: S.amount(currency), value: amount, onChange: setAmount, error: fe("amount") }
        : null,
    split: rule?.split
      ? { label: S.splitRatio, value: split, onChange: setSplit, error: fe("split") }
      : null,
    fee:
      rule?.sign !== "neutral"
        ? { label: S.fee, value: fee, onChange: setFee, error: fe("fee") }
        : null,
    currency,
    currencyOptions: [...new Set([currency, accCur, "PLN", "EUR", "USD", "GBP"])].map((c) => ({
      value: c,
      label: c,
    })),
    onCurrency: setCurPick,
    quotedIn: known && currency !== known ? S.quotedIn(known) : null,
    fx: cross
      ? { label: S.rate(accCur, currency), value: fx, onChange: setFx, error: fe("fx") }
      : null,
    note,
    onNote: setNote,
  };
}
export type TxnDrawerState = ReturnType<typeof useTxnDrawer>;

// ---- brokerage account -------------------------------------------------------------------

const brokers = (): [string, string][] => [
  ["xtb", "XTB"],
  ["dif", "DIF Broker"],
  ["binance", "Binance"],
  ["zonda", "Zonda"],
  ["manual", S.otherManual],
];

export interface AccountDrawerInput {
  onClose(): void;
  /** Saved: the new account's name (the old toast names it). */
  onSaved(account: { name: string }): void;
}

export function useAccountDrawer(input: AccountDrawerInput) {
  const [broker, setBroker] = useState("xtb");
  const [wrapper, setWrapper] = useState("regular");
  const [currency, setCurrency] = useState("PLN");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const durable = useDurableCommands();
  const add = useCommand(createUiBrokerageAccount);
  const auto = `${
    brokers()
      .find(([k]) => k === broker)?.[1]
      .split(" ")[0]
  } ${WRAPPER[wrapper]}`;
  const save = async () => {
    setBusy(true);
    setErr(null);
    const finalName = name.trim() || auto;
    try {
      const r = await durable.run("account", add, { name: finalName, broker, wrapper, currency });
      if (r.kind === "completed") input.onSaved({ name: finalName });
      else if (r.kind === "refused")
        setErr(r.reason === "account_exists" ? S.accountExists : reasonText(r.reason));
      else setErr(commandFailure(r));
    } finally {
      setBusy(false);
    }
  };
  return {
    error: err,
    busy,
    onClose: input.onClose,
    onSave: save,
    broker,
    brokerOptions: brokers().map(([value, text]) => ({ value, label: text })),
    onBroker: setBroker,
    wrapper,
    wrapperOptions: Object.entries(WRAPPER).map(([value, text]) => ({ value, label: text })),
    onWrapper: setWrapper,
    currency,
    currencyOptions: ["PLN", "EUR", "USD", "GBP", "CHF"].map((c) => ({ value: c, label: c })),
    onCurrency: setCurrency,
    name,
    namePlaceholder: auto,
    onName: setName,
  };
}
export type AccountDrawerState = ReturnType<typeof useAccountDrawer>;

// ---- thesis ------------------------------------------------------------------------------

export interface ThesisDrawerInput {
  instrumentId: number | string;
  /** The instrument's label (the head tag). */
  label: string;
  /** The latest thesis to edit, null for a new one. */
  thesis: Thesis | null;
  onClose(): void;
  onSaved(): void;
}

/** Thesis of a held or watched instrument: a new one, or an edit of the latest. */
export function useThesisDrawer(input: ThesisDrawerInput) {
  const { thesis } = input;
  const [entry, setEntry] = useState(thesis?.entry_type ?? "sentiment_correction");
  const [text, setText] = useState(thesis?.thesis ?? "");
  const [inv, setInv] = useState(thesis?.invalidation ?? "");
  const [exit, setExit] = useState(thesis?.exit_plan ?? "");
  const [size, setSize] = useState(thesis?.size_plan ?? "");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const durable = useDurableCommands();
  const create = useCommand(thesisCommands.create);
  const update = useCommand(thesisCommands.update);
  const save = async () => {
    setBusy(true);
    setErr(null);
    const values = {
      entryType: entry,
      thesis: text.trim() || null,
      invalidation: inv.trim() || null,
      exitPlan: exit.trim() || null,
      sizePlan: size.trim() || null,
    };
    try {
      const id = thesis ? gidOf(thesis.id) : null;
      const instrument = gidOf(input.instrumentId);
      const r = thesis
        ? id === null
          ? null
          : await durable.run("thesis", update, { id, values, reviewed })
        : instrument === null
          ? null
          : await durable.run("thesis", create, { instrument, ...values });
      if (r === null) setErr(reasonText("not_found"));
      else if (r.kind === "completed") input.onSaved();
      else setErr(r.kind === "refused" ? reasonText(r.reason) : commandFailure(r));
    } finally {
      setBusy(false);
    }
  };
  return {
    editing: thesis != null,
    tag: input.label,
    error: err,
    busy,
    saveDisabled: busy || !text.trim(),
    onClose: input.onClose,
    onSave: save,
    reviewed,
    onReviewed: setReviewed,
    entry,
    entryOptions: Object.entries(ENTRY_TYPE).map(([value, t]) => ({ value, label: t })),
    onEntry: setEntry,
    text,
    onText: setText,
    invalidation: inv,
    onInvalidation: setInv,
    exitPlan: exit,
    onExitPlan: setExit,
    sizePlan: size,
    onSizePlan: setSize,
  };
}
export type ThesisDrawerState = ReturnType<typeof useThesisDrawer>;

// ---- an instrument's transactions ----------------------------------------------------------

export interface TxnsDrawerInput {
  position: Position;
  accounts: readonly AccountRow[];
  onClose(): void;
  onAdd(): void;
}

const f = (v: Decimal | null): number | null => (v == null ? null : v.toFloat());

export function useTxnsDrawer(input: TxnsDrawerInput) {
  const { position, accounts } = input;
  const instrument = gidOf(position.instrument.id);
  const ledger = useQuery(ledgerQuery, { instrument, account: null });
  const src: Record<string, string> = {
    import: S.srcImport,
    manual: S.srcManual,
    reconciliation: S.srcReconciliation,
  };
  const all = [...accounts];
  // Newest first, as the old `GET /transactions` (reversed chronological order).
  const rows = ledger.ok
    ? [...ledger.rows].reverse().map((x) => {
        const acc = accounts.find((a) => gidOf(a.id) === x.accountId);
        const cash = x.cashAmount.toFloat();
        const quantity = f(x.quantity);
        const price = f(x.price);
        return {
          key: String(x.id),
          date: x.tradeDate,
          account: acc ? accountLabel(acc, all) : "-",
          type: txnType(x.type),
          quantity: quantity != null ? qty(quantity) : "-",
          price: price != null ? unitPrice(price, x.currency) : "-",
          cash: money(cash, x.cashCurrency, true),
          tone: cash > 0 ? ("positive" as const) : cash < 0 ? ("negative" as const) : null,
          source: src[x.source] ?? x.source,
        };
      })
    : null;
  return {
    tag: position.instrument.label,
    error: ledger.ok ? null : reasonText(ledger.reason),
    rows,
    onClose: input.onClose,
    onAdd: input.onAdd,
  };
}
export type TxnsDrawerState = ReturnType<typeof useTxnsDrawer>;
