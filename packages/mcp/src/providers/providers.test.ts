import { D, ibanKey } from "@cashu/domain";
import {
  importStatement,
  investmentsCommands,
  openAccount,
  removeAccount,
  setModules,
} from "@cashu/store";
import { afterEach, describe, expect, it } from "vitest";
import { nativeFixture } from "../testing/native.js";
import {
  type BudgetNameRow,
  budgetNameSources,
  type InvestmentNameRow,
  investmentNameSources,
  loadAccountLabels,
  loadGuard,
  loadNameSources,
} from "./index.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const fixture = () => {
  const f = nativeFixture();
  fixtures.push(f);
  return f;
};
function nativeSource(f: ReturnType<typeof nativeFixture>, index: number) {
  const source = loadNameSources(f.store.read.bind(f.store))[index];
  if (!source) throw new Error("missing native name provider");
  return source;
}
const base: BudgetNameRow = {
  counterpartyName: null,
  counterpartyIban: null,
  internal: false,
  reference: null,
  description: null,
};
describe("budget name provider", () => {
  it("separates own transfers, private people, card merchants and anonymous transfer titles", () => {
    const rows: BudgetNameRow[] = [
      { ...base, counterpartyName: "Anna Nowak", counterpartyIban: "PL1234" },
      { ...base, counterpartyName: "Piotr Kowalski", counterpartyIban: "PL5678" },
      { ...base, counterpartyName: "Adam Malinowski" },
      { ...base, counterpartyName: "SKLEP SPOŻYWCZY", counterpartyIban: "PL5678" },
      { ...base, reference: "BLIK NA TELEFON test" },
      { ...base, description: "synthetic invoice", counterpartyIban: "PL5678" },
      { ...base, reference: "SUPERMARKET" },
      { ...base, counterpartyName: "", reference: "BLIK" },
      { ...base, counterpartyName: "Owner Alias", internal: true },
    ];
    const source = budgetNameSources(rows, new Set([ibanKey("PL1234")]));
    expect([...source.persons]).toEqual(["Anna Nowak", "Owner Alias"]);
    expect([...source.privatePayees]).toEqual([
      "PIOTR KOWALSKI",
      "BLIK NA TELEFON TEST",
      "SYNTHETIC INVOICE",
    ]);
  });
  it("reads retained bank transactions even after disabling the module and removing the account", () => {
    const f = fixture();
    const imported = f.run(importStatement, {
      statement: {
        bank: "mbank",
        accountNumber: "PL1234",
        accountName: "Private account",
        currency: "PLN",
        transactions: [
          {
            bookingDate: "2026-10-01",
            valueDate: null,
            amount: D("-1"),
            currency: "PLN",
            counterpartyName: "Piotr Kowalski",
            counterpartyIban: "PL5678",
            description: null,
            reference: "transfer",
            bankTransactionId: null,
            source: "csv",
            raw: {},
          },
        ],
        balances: [],
        closingBalances: [],
      },
    });
    if (!imported.ok) throw new Error(imported.reason);
    expect(f.run(removeAccount, { account: imported.value.account }).ok).toBe(true);
    expect(f.run(setModules, { moduleIds: [] }).ok).toBe(true);
    expect([...nativeSource(f, 0).privatePayees]).toEqual(["PIOTR KOWALSKI"]);
  });
});
describe("investment name provider", () => {
  const market: InvestmentNameRow = {
    inProfile: true,
    own: {
      name: "Owner display",
      symbol: "0700",
      isin: "SYNTHETIC",
      assetClass: "equity",
      valuationMode: "market",
    },
    shared: { name: "Public company", symbol: "0700", isin: "SYNTHETIC" },
    overrideName: "Owner display",
  };
  it("protects both shared and overridden private identity and keeps only public numeric tickers", () => {
    const source = investmentNameSources([
      market,
      {
        ...market,
        own: { ...market.own, name: "Private loan", assetClass: "claim" },
        shared: { ...market.shared, name: "Kowalski" },
      },
      { ...market, inProfile: false, overrideName: "Detached alias" },
    ]);
    expect([...(source.knownSymbols ?? [])]).toEqual(["0700"]);
    expect([...source.persons]).toEqual(["Private loan", "0700", "Kowalski"]);
    expect([...(source.strongNames ?? [])]).toEqual([...source.persons]);
    expect([...(source.strictAliases ?? [])]).toEqual([
      ["Owner display", "Public company"],
      ["Detached alias", "Public company"],
    ]);
  });
  it("uses native overrides and excludes an unreferenced instrument", () => {
    const f = fixture();
    const created = f.run(investmentsCommands.createInstrument, {
      name: "Shared label",
      currency: "PLN",
      assetClass: "equity",
      symbol: "0700",
    });
    if (!created.ok) throw new Error(created.reason);
    expect([...(nativeSource(f, 1).knownSymbols ?? [])]).toEqual([]);
    expect(
      f.run(investmentsCommands.classifyInstrument, {
        instrument: created.value.gid,
        name: "Owner loan",
        assetClass: "claim",
      }).ok,
    ).toBe(true);
    const source = nativeSource(f, 1);
    expect(new Set(source.persons)).toEqual(new Set(["Shared label", "Owner loan", "0700"]));
    expect([...(source.knownSymbols ?? [])]).toEqual([]);
    expect([...(source.strictAliases ?? [])]).toEqual([]);
  });
});
it("keeps full creation-order labels and uses vault-distinct private payee namespaces", () => {
  const f = fixture();
  const first = f.run(openAccount, {
    bank: "mbank",
    name: "First private",
    type: "checking",
    currency: "PLN",
  });
  const second = f.run(openAccount, {
    bank: "mbank",
    name: "Second private",
    type: "checking",
    currency: "PLN",
  });
  if (!first.ok || !second.ok) throw new Error("synthetic accounts refused");
  f.run(removeAccount, { account: first.value.account });
  expect([...loadAccountLabels(f.store.read.bind(f.store)).values()]).toEqual([
    "mBank checking 1",
    "mBank checking 2",
  ]);
  const secret = new Uint8Array(32).fill(2);
  const a = loadGuard(f.store.read.bind(f.store), 1n, secret);
  const b = loadGuard(f.store.read.bind(f.store), 2n, secret);
  expect(a.payeeRef("PIOTR KOWALSKI")).not.toBe(b.payeeRef("PIOTR KOWALSKI"));
});
