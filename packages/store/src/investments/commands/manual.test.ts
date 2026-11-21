// Manual transactions: the per-type checks, instruments by gid or described (found by confirmed ISIN or
// symbol among the vault's instruments, else stored with needsClassification), currencies, derived
// amounts, cash-sign refusals and warnings, and the storage of events.md 8.5 m1 (ULID gid,
// `manual:<gid>` hash). Synthetic data.
import { describe, expect, it } from "vitest";
import { openAccount } from "../../core/commands.js";
import { loadInstrument } from "../queries/instruments.js";
import { transactions } from "../queries/transactions.js";
import { createInstrument } from "./instruments.js";
import { addManualTransaction } from "./manual.js";
import { applyRaw, brokerage, otherVault, stock, type Vault, vault } from "./testing/fixtures.js";

function setup() {
  const v = vault();
  const account = brokerage(v);
  return { v, account, read: v.store.read.bind(v.store) };
}

/** Make `instrument` one the vault references (a broker position snapshot of it). */
function reference(v: Vault, account: string, instrument: string) {
  applyRaw(v, [
    {
      type: "position.snapshotImported",
      gid: v.det("inv_position_snapshots", [account, instrument, "2026-10-01"]),
      data: {
        account,
        instrument,
        asOf: "2026-10-01",
        quantity: "1",
        currency: "PLN",
        avgPrice: null,
        marketValue: null,
        batch: null,
      },
    },
  ]);
}

const refusal = (v: Vault, input: Record<string, unknown>) => {
  const out = v.run(addManualTransaction, input);
  return out.ok ? "ok" : out.reason;
};

describe("addManualTransaction", () => {
  it("stores a ULID row with dedupHash manual:<gid> and createdAt = now; twins stay two rows", () => {
    const { v, account, read } = setup();
    const input = { account, type: " Deposit ", tradeDate: "2026-10-30", cashAmount: "100" };
    const first = v.run(addManualTransaction, input);
    if (!first.ok) expect.fail(first.reason);
    const event = first.events[0];
    expect(event?.type).toBe("invTxn.imported");
    expect(event?.gid).toBe(first.value.transaction);
    expect(event?.data).toMatchObject({
      account,
      type: "deposit",
      source: "manual",
      dedupHash: `manual:${first.value.transaction}`,
      createdAt: "2026-10-31T12:00:00.000Z",
      grossAmount: "100",
      cashAmount: "100",
      fee: "0",
      tax: "0",
      currency: "PLN",
      cashCurrency: "PLN",
    });
    v.value(addManualTransaction, input);
    expect(transactions(read).length).toBe(2);
  });

  it("refuses another vault's or a non-brokerage account and an unknown type", () => {
    const { v, account } = setup();
    const other = otherVault();
    expect(
      refusal(other, { account, type: "deposit", tradeDate: "2026-10-30", cashAmount: "1" }),
    ).toBe("no_account");
    const cash = v.value(openAccount, {
      bank: "manual",
      name: "Gotowka",
      type: "cash",
      currency: "PLN",
      externalId: "manual:G",
    }).account;
    expect(
      refusal(v, { account: cash, type: "deposit", tradeDate: "2026-10-30", cashAmount: "1" }),
    ).toBe("no_account");
    expect(refusal(v, { account, type: "short", tradeDate: "2026-10-30" })).toBe("unknown_type");
  });

  it("checks the shape per type", () => {
    const { v, account } = setup();
    const abc = stock(v, "ABC", "PL0000000ABC");
    const base = { account, tradeDate: "2026-10-30" };
    const cases: [Record<string, unknown>, string][] = [
      [{ type: "deposit", instrument: abc, cashAmount: "1" }, "instrument_forbidden"],
      [
        { type: "deposit", described: { exchange: "GPW" }, cashAmount: "1" },
        "instrument_forbidden",
      ],
      [
        { type: "buy", described: { exchange: "GPW" }, quantity: "1", price: "1" },
        "instrument_required",
      ],
      [{ type: "buy", instrument: abc, quantity: "0", price: "1" }, "quantity_required"],
      [{ type: "fee", quantity: "1", cashAmount: "-1" }, "quantity_forbidden"],
      [{ type: "split", instrument: abc }, "split_ratio_required"],
      [{ type: "dividend", splitRatio: "2", cashAmount: "1" }, "split_ratio_forbidden"],
      [{ type: "buy", instrument: abc, quantity: "1", price: "-1" }, "negative_price"],
      [{ type: "dividend", grossAmount: "-1" }, "negative_gross_amount"],
      [{ type: "dividend", fee: "-1", cashAmount: "1" }, "negative_fee"],
      [{ type: "dividend", tax: "-1", cashAmount: "1" }, "negative_tax"],
      [{ type: "dividend", fxRate: "0", cashAmount: "1" }, "invalid_fx_rate"],
    ];
    for (const [input, reason] of cases) {
      expect(refusal(v, { ...base, ...input }), JSON.stringify(input)).toBe(reason);
    }
  });

  it("finds the instrument by gid only among the vault's referenced instruments", () => {
    const { v, account, read } = setup();
    const abc = stock(v, "ABC", "PL0000000ABC");
    const sell = { account, type: "sell", tradeDate: "2026-10-30", quantity: 100, price: 60 };
    expect(refusal(v, { ...sell, instrument: abc })).toBe("no_instrument"); // not referenced yet
    reference(v, account, abc);
    const out = v.value(addManualTransaction, { ...sell, instrument: abc });
    expect([out.instrument, out.newInstrument, out.warnings]).toEqual([abc, false, []]);
    const row = transactions(read).find((t) => t.id === out.transaction);
    expect([row?.grossAmount.toString(), row?.cashAmount.toString(), row?.currency]).toEqual([
      "6000",
      "6000",
      "PLN",
    ]);
  });

  it("converts a cross-currency sell with fx_rate", () => {
    const { v, account, read } = setup();
    const xmpl = stock(v, "XMPL", "US0000000001", { currency: "USD" });
    reference(v, account, xmpl);
    const out = v.value(addManualTransaction, {
      account,
      type: "sell",
      tradeDate: "2026-02-27",
      instrument: xmpl,
      quantity: 20,
      price: 200,
      currency: "USD",
      cashCurrency: "PLN",
      fxRate: 4,
    });
    const row = transactions(read).find((t) => t.id === out.transaction);
    expect([row?.grossAmount.toString(), row?.cashAmount.toString(), row?.cashCurrency]).toEqual([
      "4000",
      "16000",
      "PLN",
    ]);
    const missing = refusal(v, {
      account,
      type: "sell",
      tradeDate: "2026-02-27",
      instrument: xmpl,
      quantity: 1,
      price: 1,
      cashCurrency: "PLN",
    });
    expect(missing).toBe("amount_fx_missing");
  });

  it("stores a described instrument once every check passed", () => {
    const { v, account, read } = setup();
    const buy = {
      account,
      type: "buy",
      tradeDate: "2026-02-02",
      described: { symbol: "BOND1", name: "Example bond", currency: "PLN" },
      quantity: 1,
      price: 100,
      currency: "PLN",
    };
    // a failing check stores nothing
    expect(refusal(v, { ...buy, cashAmount: "5" })).toBe("buy_cash_positive");
    expect(read("SELECT gid FROM inv_instruments")).toEqual([]);
    const out = v.value(addManualTransaction, buy);
    expect(out.newInstrument).toBe(true);
    const inst = out.instrument === null ? undefined : loadInstrument(read, out.instrument);
    expect([inst?.symbol, inst?.name, inst?.needsClassification, inst?.assetClass]).toEqual([
      "BOND1",
      "Example bond",
      true,
      "other",
    ]);
    // the same symbol again finds it among the vault's instruments
    const again = v.value(addManualTransaction, { ...buy, described: { symbol: "bond1" } });
    expect([again.instrument, again.newInstrument]).toEqual([out.instrument, false]);
  });

  it("finds a described instrument by confirmed ISIN, by symbol and MIC, never a different ISIN", () => {
    const { v, account } = setup();
    const abc = stock(v, "ABC", "PL0000000AB1");
    const buy = { account, type: "buy", tradeDate: "2026-10-30", quantity: 1, price: 1 };
    const byIsin = v.value(addManualTransaction, { ...buy, described: { isin: "pl0000000ab1" } });
    expect([byIsin.instrument, byIsin.newInstrument]).toEqual([abc, false]);
    expect(refusal(v, { ...buy, described: { isin: "PL123" } })).toBe("invalid_isin");
    // ABC is referenced now (the buy above); another market or another ISIN is a new instrument
    const gpw = v.value(addManualTransaction, {
      ...buy,
      described: { symbol: "abc", exchange: "GPW" },
    });
    expect(gpw.instrument).toBe(abc);
    const otherIsin = v.value(addManualTransaction, {
      ...buy,
      described: { symbol: "ABC", isin: "DE0000000AB2" },
    });
    expect(otherIsin.newInstrument).toBe(true);
    expect(otherIsin.instrument).not.toBe(abc);
    // a listing without an ISIN on another market is new too; later the bare symbol may find it
    const xetra = v.value(addManualTransaction, {
      ...buy,
      described: { symbol: "ABC", exchange: "XETR" },
    });
    expect(xetra.newInstrument).toBe(true);
  });

  it("checks currencies, fx conversion legs and the asset class", () => {
    const { v, account } = setup();
    const base = { account, tradeDate: "2026-10-30" };
    const cases: [Record<string, unknown>, string][] = [
      [{ type: "deposit", cashAmount: "1", currency: "zl" }, "invalid_currency"],
      [{ type: "deposit", cashAmount: "1", cashCurrency: "zl" }, "invalid_cash_currency"],
      [{ type: "fx_conversion", cashAmount: "0" }, "fx_conversion_cash_required"],
      [
        { type: "fx_conversion", cashAmount: "5", cashCurrency: "EUR" },
        "fx_conversion_currency_mismatch",
      ],
      [
        { type: "buy", described: { symbol: "N1", currency: "xx" }, quantity: 1, price: 1 },
        "invalid_instrument_currency",
      ],
      [
        { type: "buy", described: { symbol: "N1", assetClass: "stock" }, quantity: 1, price: 1 },
        "unknown_asset_class",
      ],
      [{ type: "dividend" }, "amount_invalid"],
    ];
    for (const [input, reason] of cases) {
      expect(refusal(v, { ...base, ...input }), JSON.stringify(input)).toBe(reason);
    }
    const usd = v.value(addManualTransaction, {
      ...base,
      type: "buy",
      described: { symbol: "N2", currency: "usd", assetClass: "ETF" },
      quantity: 2,
      price: 3,
    });
    const inst =
      usd.instrument === null
        ? undefined
        : loadInstrument(v.store.read.bind(v.store), usd.instrument);
    expect([inst?.currency, inst?.assetClass]).toEqual(["USD", "etf"]); // the trade currency follows it
  });

  it("refuses contradicting cash signs and warns on unusual ones", () => {
    const { v, account } = setup();
    const base = { account, tradeDate: "2026-10-30" };
    const abc = stock(v, "ABC", "PL0000000ABC");
    reference(v, account, abc);
    for (const [input, reason] of [
      [
        { type: "sell", instrument: abc, quantity: 1, price: 1, cashAmount: "-1" },
        "sell_cash_negative",
      ],
      [{ type: "deposit", cashAmount: "-1" }, "deposit_cash_negative"],
      [{ type: "withdrawal", cashAmount: "1" }, "withdrawal_cash_positive"],
      [{ type: "transfer_in", instrument: abc, quantity: 1, cashAmount: "1" }, "cash_not_neutral"],
    ] as const) {
      expect(refusal(v, { ...base, ...input }), JSON.stringify(input)).toBe(reason);
    }
    const dividend = v.value(addManualTransaction, {
      ...base,
      type: "dividend",
      cashAmount: "-2.5",
    });
    expect(dividend.warnings).toEqual([
      { code: "negative_cash_income", params: { type: "dividend", cashAmount: "-2.5" } },
    ]);
    const refund = v.value(addManualTransaction, { ...base, type: "fee", cashAmount: "3" });
    expect(refund.warnings).toEqual([
      { code: "positive_cash_cost", params: { type: "fee", cashAmount: "3" } },
    ]);
    const split = v.value(addManualTransaction, {
      ...base,
      type: "split",
      instrument: abc,
      splitRatio: "2",
    });
    expect(split.warnings).toEqual([]);
  });

  it("defaults the trade currency to the instrument's, then the account's", () => {
    const { v, read } = setup();
    const eur = v.value(openAccount, {
      bank: "xtb",
      name: "EUR",
      type: "brokerage",
      currency: "EUR",
      externalId: "brokerage:eur",
    }).account;
    const usd = v.value(createInstrument, {
      name: "U SA",
      currency: "USD",
      assetClass: "equity",
      isin: "US00000000U1",
    }).gid;
    reference(v, eur, usd);
    const buy = v.value(addManualTransaction, {
      account: eur,
      type: "buy",
      tradeDate: "2026-10-30",
      instrument: usd,
      quantity: 1,
      price: 1,
      cashAmount: "-1",
    });
    const deposit = v.value(addManualTransaction, {
      account: eur,
      type: "deposit",
      tradeDate: "2026-10-30",
      cashAmount: "1",
    });
    const byId = new Map(transactions(read).map((t) => [String(t.id), t]));
    expect([byId.get(buy.transaction)?.currency, byId.get(deposit.transaction)?.currency]).toEqual([
      "USD",
      "EUR",
    ]);
  });
});
