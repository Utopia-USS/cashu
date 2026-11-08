// Brokerage accounts and their settings: a name is unique per broker (case-insensitive), the broker,
// wrapper and currency are validated. Synthetic data only.
import { describe, expect, it } from "vitest";
import { accountByGid } from "../../core/queries.js";
import { accountSettings, brokerageAccounts } from "../queries/transactions.js";
import { addBrokerageAccount } from "./accounts.js";
import { type Vault, vault } from "./testing/fixtures.js";

const refusal = (v: Vault, input: Record<string, unknown>) => {
  const out = v.run(addBrokerageAccount, input);
  return out.ok ? "ok" : out.reason;
};

describe("addBrokerageAccount", () => {
  it("opens a brokerage account with its wrapper and currency", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    const { account } = v.value(addBrokerageAccount, {
      name: "DIF",
      broker: "dif",
      wrapper: "regular",
    });
    const row = accountByGid(read, account);
    expect([row?.name, row?.bank, row?.currency, row?.type]).toEqual([
      "DIF",
      "dif",
      "PLN",
      "brokerage",
    ]);
    expect(accountSettings(read, account)).toEqual({
      account,
      wrapper: "regular",
      importer: null,
      mappingYaml: null,
    });
    const xtb = v.value(addBrokerageAccount, {
      name: "X",
      broker: "xtb",
      wrapper: "ike",
      currency: "eur",
    });
    expect(accountByGid(read, xtb.account)?.currency).toBe("EUR");
    expect(accountSettings(read, xtb.account).wrapper).toBe("ike");
    expect(brokerageAccounts(read).map((a) => a.gid)).toEqual([account, xtb.account]);
  });

  it("refuses a duplicate name at the same broker and invalid input", () => {
    const v = vault();
    v.value(addBrokerageAccount, { name: " Konto  ", broker: "xtb" });
    expect(refusal(v, { name: "konto", broker: "xtb" })).toBe("account_exists");
    expect(refusal(v, { name: "KONTO", broker: "dif" })).toBe("ok");
    expect(refusal(v, { name: "  ", broker: "xtb" })).toBe("name_required");
    expect(refusal(v, { name: "A", broker: "mbank" })).toBe("unknown_broker");
    expect(refusal(v, { name: "A", broker: "xtb", wrapper: "x" })).toBe("unknown_wrapper");
    expect(refusal(v, { name: "A", broker: "xtb", currency: "PLNX" })).toBe("invalid_currency");
    expect(refusal(v, { name: "Gotowka", broker: "manual" })).toBe("ok");
  });
});
