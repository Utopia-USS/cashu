// Manual transactions (Python `service/transactions.py:add_manual`): one account event typed in by
// hand, checked with the per-type rules of the canonical import format (docs/import-format.md 4) and
// stored like an imported row (`source = manual`). Storage differs from Python on purpose
// (events.md 8.5 m1): the gid is a ULID and `dedupHash = "manual:" + gid`, so two identical manual rows
// (also from two devices) stay two rows; there is no free-occurrence content hash.
import { D, type Decimal, pyLower, pyStrip, pyUpper, tryCurrency, ZERO } from "@cashu/domain";
import {
  AliasNamespace,
  type Currency,
  type Instrument,
  isAssetClass,
  isTxnType,
  TxnType,
} from "@cashu/domain/investments";
import { deriveAmounts, exchangeForHint } from "@cashu/domain/investments/importing";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../../command.js";
import { decimalInput } from "../../core/commands.js";
import { accountByMemberGid } from "../../core/queries.js";
import { calendarDate, gid } from "../../events/v1/primitives.js";
import {
  instrumentByIsin,
  loadInstrument,
  loadInstruments,
  vaultInstrumentGids,
} from "../queries/instruments.js";
import { instrumentGid } from "../queries/shared.js";
import { brokerageAccount } from "../queries/transactions.js";
import { type InstrumentSpec, instrumentSpec, storeInstrument } from "./instruments.js";
import { bookMatchingPlans } from "./planned.js";

const INSTRUMENT_REQUIRED: ReadonlySet<TxnType> = new Set([
  TxnType.BUY,
  TxnType.SELL,
  TxnType.SPLIT,
  TxnType.TRANSFER_IN,
  TxnType.TRANSFER_OUT,
  TxnType.ADJUSTMENT,
]);
const INSTRUMENT_FORBIDDEN: ReadonlySet<TxnType> = new Set([
  TxnType.DEPOSIT,
  TxnType.WITHDRAWAL,
  TxnType.FX_CONVERSION,
]);
const QUANTITY_REQUIRED: ReadonlySet<TxnType> = new Set([
  TxnType.BUY,
  TxnType.SELL,
  TxnType.TRANSFER_IN,
  TxnType.TRANSFER_OUT,
  TxnType.ADJUSTMENT,
]);
const QUANTITY_FORBIDDEN: ReadonlySet<TxnType> = new Set([
  TxnType.INTEREST,
  TxnType.DEPOSIT,
  TxnType.WITHDRAWAL,
  TxnType.FEE,
  TxnType.TAX,
  TxnType.FX_CONVERSION,
]);
const CASH_NEUTRAL: ReadonlySet<TxnType> = new Set([
  TxnType.SPLIT,
  TxnType.TRANSFER_IN,
  TxnType.TRANSFER_OUT,
  TxnType.ADJUSTMENT,
]);

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const MIC = /^[A-Z]{4}$/;

/** Refusals Python raises as `ManualTxnNotFound` (the API answers 404); the rest are 422. */
export const MANUAL_NOT_FOUND_REASONS = ["no_account", "no_instrument"] as const;

const text = z.string().nullable().optional();
const amount = decimalInput.nullable().optional();

const describedInput = z.object({
  symbol: text,
  isin: text,
  name: text,
  currency: text,
  exchange: text,
  assetClass: text,
});
type Described = z.infer<typeof describedInput>;

/** Python `_clean`: stripped text, null when blank. */
const clean = (value: string | null | undefined): string | null =>
  value == null ? null : pyStrip(value) || null;

/** Python `InstrumentInput.identifies`: it names an instrument (symbol, ISIN or name). */
const identifies = (d: Described | null | undefined): d is Described =>
  d != null && [d.symbol, d.isin, d.name].some((v) => clean(v) !== null);

/** Python `_mic`: the MIC an exchange text names (a known market, or a 4-letter MIC); else null. */
function micOf(exchange: string | null | undefined): string | null {
  const t = clean(exchange);
  if (t === null) return null;
  const known = exchangeForHint(t);
  if (known?.mic) return known.mic;
  const upper = pyUpper(t);
  return MIC.test(upper) ? upper : null;
}

/** A warning on a stored row: a code and its params (the copy lives in the UI catalogs). */
export interface ManualTxnWarning {
  readonly code: "negative_cash_income" | "positive_cash_cost";
  readonly params: { readonly type: string; readonly cashAmount: string };
}

const manualTxnInput = z.object({
  account: gid,
  type: z.string(),
  tradeDate: calendarDate,
  /** An instrument the vault references; wins over `described`. */
  instrument: gid.nullable().optional(),
  /** An instrument described by hand (used when no `instrument` is given). */
  described: describedInput.nullable().optional(),
  quantity: amount,
  price: amount,
  grossAmount: amount,
  fee: amount,
  tax: amount,
  /** Signed net cash effect in `cashCurrency`; derived from the gross amount when empty. */
  cashAmount: amount,
  fxRate: amount,
  splitRatio: amount,
  /** Trade currency; default: the instrument's, else the account's. */
  currency: text,
  /** Default: `currency`. */
  cashCurrency: text,
  note: text,
});
type ManualInput = z.infer<typeof manualTxnInput>;
type Amounts = Record<
  "quantity" | "price" | "grossAmount" | "fee" | "tax" | "cashAmount" | "fxRate" | "splitRatio",
  Decimal | null
>;

/** Python `_validate_shape`: instrument / quantity / split ratio presence and the plain signs. */
function shapeError(type: TxnType, input: ManualInput, a: Amounts): string | null {
  const d = input.described;
  const described =
    d != null && [d.symbol, d.isin, d.name, d.exchange].some((v) => clean(v) !== null);
  const hasInstrument = input.instrument != null || Boolean(described);
  if (INSTRUMENT_FORBIDDEN.has(type) && hasInstrument) return "instrument_forbidden";
  if (INSTRUMENT_REQUIRED.has(type) && !(input.instrument != null || identifies(input.described))) {
    return "instrument_required";
  }
  if (QUANTITY_REQUIRED.has(type) && (a.quantity === null || !a.quantity.gt(ZERO))) {
    return "quantity_required";
  }
  if (QUANTITY_FORBIDDEN.has(type) && a.quantity !== null) return "quantity_forbidden";
  if (type === TxnType.SPLIT) {
    if (a.splitRatio === null || !a.splitRatio.gt(ZERO)) return "split_ratio_required";
  } else if (a.splitRatio !== null) {
    return "split_ratio_forbidden";
  }
  const signed = [
    ["quantity", a.quantity],
    ["price", a.price],
    ["gross_amount", a.grossAmount],
    ["fee", a.fee],
    ["tax", a.tax],
  ] as const;
  for (const [name, value] of signed) {
    if (value?.lt(ZERO)) return `negative_${name}`;
  }
  if (a.fxRate !== null && !a.fxRate.gt(ZERO)) return "invalid_fx_rate";
  return null;
}

/**
 * Python `_check_cash_sign`: a refusal for a cash amount whose sign contradicts the type, a warning
 * for the types where the other sign is unusual but possible (a dividend correction, a fee refund).
 */
function cashSign(
  type: TxnType,
  cash: Decimal,
): { refusal: string } | { warning: ManualTxnWarning } | null {
  if (type === TxnType.BUY && cash.gt(ZERO)) return { refusal: "buy_cash_positive" };
  if (type === TxnType.SELL && cash.lt(ZERO)) return { refusal: "sell_cash_negative" };
  if (type === TxnType.DEPOSIT && cash.lt(ZERO)) return { refusal: "deposit_cash_negative" };
  if (type === TxnType.WITHDRAWAL && cash.gt(ZERO)) return { refusal: "withdrawal_cash_positive" };
  if (CASH_NEUTRAL.has(type) && !cash.isZero()) return { refusal: "cash_not_neutral" };
  const params = { type, cashAmount: cash.format("f") };
  if ((type === TxnType.DIVIDEND || type === TxnType.INTEREST) && cash.lt(ZERO)) {
    return { warning: { code: "negative_cash_income", params } };
  }
  if ((type === TxnType.FEE || type === TxnType.TAX) && cash.gt(ZERO)) {
    return { warning: { code: "positive_cash_cost", params } };
  }
  return null;
}

/**
 * Python `_find_described`: a stored instrument the description means: the same ISIN (confirmed),
 * else the same symbol among the instruments the vault references (and the same MIC when an exchange
 * is given; a different stored ISIN is another listing / security with the same ticker).
 */
function findDescribed(
  ctx: CommandContext,
  d: Described,
  isin: string | null,
  mic: string | null,
): Instrument | undefined {
  if (isin !== null) {
    const found = instrumentByIsin(ctx.read, isin, { confirmedOnly: true });
    if (found !== undefined) return found;
  }
  const symbol = clean(d.symbol);
  if (symbol === null) return undefined;
  const upper = pyUpper(symbol);
  const referenced = [...vaultInstrumentGids(ctx.read)];
  const loaded = loadInstruments(ctx.read, referenced);
  for (const g of referenced) {
    const inst = loaded.get(g);
    if (inst === undefined || pyUpper(pyStrip(inst.symbol ?? "")) !== upper) continue;
    if (mic !== null && inst.mic !== mic) continue;
    if (isin !== null && inst.isin && pyUpper(inst.isin) !== isin) continue;
    return inst;
  }
  return undefined;
}

const dec = (v: string | null | undefined): Decimal | null => (v == null ? null : D(v));

/** `tryCurrency` of a present value; `undefined` marks a refusal. */
const currencyOf = (v: string): Currency | undefined => tryCurrency(v) ?? undefined;

export const addManualTransaction = defineCommand({
  id: "investments.addManualTransaction",
  input: manualTxnInput,
  /**
   * Python `add_manual`, same checks in the same order. A described instrument that is not stored
   * yet is stored (`needsClassification`) only after every check passed; a deposit books a matching
   * planned deposit in the same batch.
   */
  run(ctx, input) {
    const root = accountByMemberGid(ctx.read, input.account)?.gid ?? input.account;
    const account = brokerageAccount(ctx.read, root);
    if (account === undefined) return refuse("no_account");
    const typeText = pyLower(pyStrip(input.type));
    if (!isTxnType(typeText)) return refuse("unknown_type");
    const type = typeText;
    const a: Amounts = {
      quantity: dec(input.quantity),
      price: dec(input.price),
      grossAmount: dec(input.grossAmount),
      fee: dec(input.fee),
      tax: dec(input.tax),
      cashAmount: dec(input.cashAmount),
      fxRate: dec(input.fxRate),
      splitRatio: dec(input.splitRatio),
    };
    const shape = shapeError(type, input, a);
    if (shape !== null) return refuse(shape);

    // Instrument (looked up now, stored at the end).
    let existing: Instrument | undefined;
    const spec = input.instrument == null ? (input.described ?? null) : null;
    let isin: string | null = null;
    let mic: string | null = null;
    if (input.instrument != null) {
      const g = instrumentGid(ctx.read, input.instrument);
      if (g === undefined || !vaultInstrumentGids(ctx.read).has(g)) return refuse("no_instrument");
      existing = loadInstrument(ctx.read, g);
      if (existing === undefined) return refuse("no_instrument");
    } else if (identifies(spec)) {
      isin = pyUpper(clean(spec.isin) ?? "") || null;
      if (isin !== null && !ISIN.test(isin)) return refuse("invalid_isin");
      mic = micOf(spec.exchange);
      existing = findDescribed(ctx, spec, isin, mic);
    }

    // Currencies.
    let currency: Currency | undefined;
    if (input.currency != null && clean(input.currency) !== null) {
      currency = currencyOf(input.currency);
      if (currency === undefined) return refuse("invalid_currency");
    } else if (existing !== undefined) {
      currency = existing.currency;
    } else if (spec?.currency != null && clean(spec.currency) !== null) {
      currency = currencyOf(spec.currency);
      if (currency === undefined) return refuse("invalid_instrument_currency");
    } else {
      currency = currencyOf(account.currency);
      if (currency === undefined) return refuse("invalid_account_currency");
    }
    let cashCurrency: Currency | undefined = currency;
    if (input.cashCurrency != null && clean(input.cashCurrency) !== null) {
      cashCurrency = currencyOf(input.cashCurrency);
      if (cashCurrency === undefined) return refuse("invalid_cash_currency");
    }
    if (type === TxnType.FX_CONVERSION) {
      if (a.cashAmount === null || a.cashAmount.isZero())
        return refuse("fx_conversion_cash_required");
      if (cashCurrency !== currency) return refuse("fx_conversion_currency_mismatch");
    }
    let planned: InstrumentSpec | null = null;
    if (existing === undefined && identifies(spec)) {
      const symbol = clean(spec.symbol);
      const assetClass = pyLower(clean(spec.assetClass) ?? "other");
      if (!isAssetClass(assetClass)) return refuse("unknown_asset_class");
      let instrumentCurrency: Currency | undefined = currency;
      if (spec.currency != null && clean(spec.currency) !== null) {
        instrumentCurrency = currencyOf(spec.currency);
        if (instrumentCurrency === undefined) return refuse("invalid_instrument_currency");
      }
      planned = instrumentSpec.parse({
        name: clean(spec.name) ?? symbol ?? isin ?? "",
        currency: instrumentCurrency,
        assetClass,
        symbol,
        isin,
        mic,
        needsClassification: true,
        aliases: isin === null ? [] : [{ namespace: AliasNamespace.ISIN, value: isin }],
      });
    }

    // Amounts and the cash sign.
    const fee = a.fee ?? ZERO;
    const tax = a.tax ?? ZERO;
    const amounts = deriveAmounts({
      txnType: type,
      currency,
      cashCurrency,
      gross: a.grossAmount,
      cash: a.cashAmount,
      quantity: a.quantity,
      price: a.price,
      fee,
      tax,
      fxRate: a.fxRate,
    });
    if (!amounts.ok) {
      return refuse(amounts.kind === "fx_missing" ? "amount_fx_missing" : "amount_invalid");
    }
    const { grossAmount, cashAmount } = amounts.value;
    const warnings: ManualTxnWarning[] = [];
    const sign = cashSign(type, cashAmount);
    if (sign !== null && "refusal" in sign) return refuse(sign.refusal);
    if (sign !== null) warnings.push(sign.warning);

    // Store: the new instrument (if any), then the row.
    let instrument: string | null = existing?.id ?? null;
    let newInstrument = false;
    if (planned !== null) {
      const stored = storeInstrument(ctx, planned);
      instrument = stored.gid;
      newInstrument = stored.created;
    }
    const txn = ctx.newGid();
    const cash = cashAmount.format("f");
    ctx.emit("invTxn.imported", txn, {
      account: root,
      batch: null,
      type,
      tradeDate: input.tradeDate,
      settleDate: null,
      instrument,
      quantity: input.quantity ?? null,
      price: input.price ?? null,
      currency,
      grossAmount: grossAmount.format("f"),
      fee: input.fee ?? "0",
      tax: input.tax ?? "0",
      cashAmount: cash,
      cashCurrency,
      fxRate: input.fxRate ?? null,
      splitRatio: input.splitRatio ?? null,
      note: clean(input.note),
      source: "manual",
      externalRef: null,
      dedupHash: `manual:${txn}`,
      createdAt: ctx.now(),
    });
    // a deposit booked by hand books a matching plan too (F6)
    const booked =
      type === TxnType.DEPOSIT
        ? bookMatchingPlans(ctx, [
            {
              gid: txn,
              account: root,
              tradeDate: input.tradeDate,
              cashAmount: cash,
              cashCurrency,
            },
          ])
        : [];
    return ok({ transaction: txn, account: root, instrument, newInstrument, warnings, booked });
  },
});
