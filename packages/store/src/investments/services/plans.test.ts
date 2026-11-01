// P1: the model recommendation write (legacy `plan` storage): every value and null, refusals for an
// unknown value, an instrument outside the vault and a held-only plan on an instrument not held, the
// stored value kept when it goes stale, per-vault plans. Translates the store-level parts of
// tests/investments/persistence/test_p1_plan.py (views of the plan: S22a; the plan checks of the daily
// run and right after a write: S15b / S22c; MCP: S38). Synthetic data only.
import { sha256Hex } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { storeWriter } from "../../command.js";
import { addBrokerageAccount } from "../commands/accounts.js";
import { commitImport } from "../commands/imports.js";
import { createInstrument } from "../commands/instruments.js";
import { addManualTransaction } from "../commands/manual.js";
import { applyRaw, otherVault, raw, type Vault, vault } from "../commands/testing/fixtures.js";
import { heldSince } from "../queries/holdings.js";
import { allInstruments, loadInstrument, overrides } from "../queries/instruments.js";
import { writePlan } from "./plans.js";

const HEADER =
  "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price," +
  "currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source";
const FILE = new TextEncoder().encode(
  `${[
    HEADER,
    "1,txn,2026-01-05,09:00,deposit,T-1,,,,,,,PLN,,,,20000.00,,,,examplebroker",
    "1,txn,2026-01-07,09:15,buy,T-2,ABC,PLABC0000016,ABC Example SA,XWAR,100,50.00,PLN,5000.00,5.00,,-5005.00,,,,",
    "1,txn,2026-01-14,16:00,buy,T-4,XMPL,US0000000001,Example Corp,XNAS,20,100.00,USD,2000.00,,,-8000.00,PLN,4.0,,",
  ].join("\n")}\n`,
);
const TODAY = "2026-03-02";

function investor(v: Vault = vault()) {
  const account = v.value(addBrokerageAccount, { name: "Konto DIF", broker: "dif" }).account;
  v.value(commitImport, {
    account,
    file: { name: "history.csv", content: FILE },
    archive: { sha256: sha256Hex(FILE), ext: "csv" },
  });
  const read = v.store.read.bind(v.store);
  const id = (symbol: string) => {
    const found = allInstruments(read).find((i) => i.symbol === symbol);
    if (found === undefined) throw new Error(`${symbol} not stored`);
    return found.id;
  };
  const put = (instrument: string, plan: unknown) =>
    writePlan(
      { store: v.store, writer: storeWriter(v.store), env: v.env },
      { instrument, plan: plan as string | null, today: TODAY },
    );
  return { v, account, read, id, put };
}

describe("plan write (test_p1_plan.py)", () => {
  it("test_put_plan_values_null_and_errors", () => {
    const { v, read, id, put } = investor();
    const xmpl = id("XMPL");
    for (const value of ["buy_asap", "buy", "hold", "reduce", "exit_asap"]) {
      expect(put(xmpl, value).ok).toBe(true);
      const inst = loadInstrument(read, xmpl);
      expect([inst?.plan, inst?.planAt === null]).toEqual([value, false]);
    }
    expect(put(xmpl, null).ok).toBe(true);
    expect(overrides(read, [xmpl]).get(xmpl)).toMatchObject({ plan: null, planAt: null });
    expect(put(xmpl, "sell")).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(put(xmpl, 3)).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(put("0".repeat(26), "hold")).toEqual({ ok: false, reason: "no_instrument" });
    // an instrument of this vault no row references (Python: another profile's)
    const foreign = v.value(createInstrument, {
      name: "Foreign Example",
      currency: "USD",
      assetClass: "equity",
    }).gid;
    expect(put(foreign, "hold")).toEqual({ ok: false, reason: "no_instrument" });
    // a watched (not held) instrument: buy / hold yes, reduce / exit_asap no
    const watched = v.value(createInstrument, {
      name: "VWCE",
      currency: "EUR",
      assetClass: "etf",
      aliases: [{ namespace: "yahoo", value: "VWCE.DE" }],
    }).gid;
    applyRaw(v, [raw.watchAdded(v, watched)]);
    for (const value of ["reduce", "exit_asap"]) {
      expect(put(watched, value)).toEqual({ ok: false, reason: "needs_held" });
    }
    expect(put(watched, "buy").ok).toBe(true);
    expect(loadInstrument(read, watched)?.plan).toBe("buy");
  });

  it("test_stale_reduce_plan_of_a_sold_position_is_emitted_null (store part)", () => {
    const { v, account, read, id, put } = investor();
    const abc = id("ABC");
    expect(put(abc, "reduce").ok).toBe(true);
    v.value(addManualTransaction, {
      account,
      type: "sell",
      tradeDate: "2026-02-20",
      instrument: abc,
      quantity: "100",
      price: "60",
    });
    expect(heldSince(read, TODAY).has(abc)).toBe(false);
    // the stored plan stays (the history); a new held-only plan needs a held instrument
    expect(overrides(read, [abc]).get(abc)?.plan).toBe("reduce");
    expect(put(abc, "reduce")).toEqual({ ok: false, reason: "needs_held" });
    expect(put(abc, "hold").ok).toBe(true);
    expect(loadInstrument(read, abc)?.plan).toBe("hold");
  });

  it("test_plan_is_per_profile", () => {
    const a = investor();
    const b = investor(otherVault());
    const xmplA = a.id("XMPL");
    const xmplB = b.id("XMPL");
    a.put(xmplA, "buy_asap");
    expect(loadInstrument(b.read, xmplB)?.plan ?? null).toBeNull();
    b.put(xmplB, "exit_asap");
    expect(loadInstrument(a.read, xmplA)?.plan).toBe("buy_asap");
  });

  it("test_put_plan_needs_the_plan_key", () => {
    const { v, read, id, put } = investor();
    const xmpl = id("XMPL");
    put(xmpl, "hold");
    for (const plan of [undefined]) {
      const out = writePlan(
        { store: v.store, writer: storeWriter(v.store), env: v.env },
        { instrument: xmpl, plan: plan as unknown as null, today: TODAY },
      );
      expect(out).toMatchObject({ ok: false, reason: "invalid_input" });
    }
    expect(loadInstrument(read, xmpl)?.plan).toBe("hold");
    expect(put(xmpl, null).ok).toBe(true);
    expect(loadInstrument(read, xmpl)?.plan ?? null).toBeNull();
  });

  it("test_a_reduce_plan_from_before_a_rebuy_is_stale (store part)", () => {
    const { v, account, read, id, put } = investor();
    const abc = id("ABC");
    put(abc, "reduce");
    for (const body of [
      { type: "sell", tradeDate: "2026-02-10", quantity: "100", price: "55" },
      { type: "buy", tradeDate: "2026-02-15", quantity: "100", price: "30" },
    ]) {
      v.value(addManualTransaction, { account, instrument: abc, ...body });
    }
    // held again since the re-buy: the opened date moves past the plan, the stored value stays
    expect(heldSince(read, TODAY).get(abc)).toBe("2026-02-15");
    expect(overrides(read, [abc]).get(abc)?.plan).toBe("reduce");
    expect(put(abc, "reduce").ok).toBe(true); // a plan written again after the re-buy
  });
});
