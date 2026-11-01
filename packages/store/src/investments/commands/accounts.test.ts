// Brokerage accounts (Python `service/accounts.py:add_account`) and their settings (wrapper, the
// importer and mapping the import commit remembers, step 6). Store-level part of
// tests/investments/persistence/test_invp_api.py::test_accounts_endpoint. Synthetic data only.
import { describe, expect, it } from "vitest";
import { accountByGid } from "../../core/queries.js";
import { accountSettings, brokerageAccounts } from "../queries/transactions.js";
import {
  addBrokerageAccount,
  brokerIds,
  rememberAccountImporter,
  setAccountSettings,
} from "./accounts.js";
import { brokerage, otherVault, type Vault, vault } from "./testing/fixtures.js";

const refusal = (v: Vault, input: Record<string, unknown>) => {
  const out = v.run(addBrokerageAccount, input);
  return out.ok ? "ok" : out.reason;
};

describe("addBrokerageAccount (test_accounts_endpoint)", () => {
  it("accounts endpoint", () => {
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
    expect(refusal(v, { name: "dif", broker: "dif" })).toBe("account_exists");
    expect(refusal(v, { name: "X", broker: "mbank" })).toBe("unknown_broker");
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

  it("checks the name, broker, wrapper and currency in Python's order", () => {
    const v = vault();
    expect(refusal(v, { name: "  ", broker: "nope", wrapper: "x", currency: "1" })).toBe(
      "name_required",
    );
    expect(refusal(v, { name: "A", broker: "nope", wrapper: "x", currency: "1" })).toBe(
      "unknown_broker",
    );
    expect(refusal(v, { name: "A", broker: "xtb", wrapper: "x", currency: "1" })).toBe(
      "unknown_wrapper",
    );
    expect(refusal(v, { name: "A", broker: "xtb", currency: "PLNX" })).toBe("invalid_currency");
    expect(brokerIds()).toEqual(
      expect.arrayContaining(["dif", "xtb", "binance", "zonda", "manual"]),
    );
    expect(refusal(v, { name: "Gotowka", broker: "manual" })).toBe("ok");
  });

  it("opens a ULID account with a random brokerage key; the same name at another broker is fine", () => {
    const v = vault();
    const out = v.run(addBrokerageAccount, { name: " Konto  ", broker: "xtb" });
    if (!out.ok) expect.fail(out.reason);
    const [opened, settings] = out.events;
    expect(opened?.type).toBe("account.opened");
    expect(opened?.gid).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(opened?.data).toMatchObject({ bank: "xtb", name: "Konto", keys: [] });
    expect(String(opened?.data.externalId)).toMatch(/^brokerage:[0-9a-f]{32}$/);
    expect(settings?.type).toBe("invAccount.settingsSet");
    expect(settings?.data).toEqual({ account: out.value.account, wrapper: "regular" });
    expect(refusal(v, { name: "KONTO", broker: "dif" })).toBe("ok");
    expect(refusal(v, { name: "konto", broker: "xtb" })).toBe("account_exists");
  });
});

describe("account settings", () => {
  it("patches only changed fields and refuses another vault's account", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    const account = brokerage(v);
    const first = v.run(setAccountSettings, { account, wrapper: "ikze", importer: "xtb" });
    expect(first.ok && first.events.map((e) => e.data)).toEqual([
      { account, wrapper: "ikze", importer: "xtb" },
    ]);
    const same = v.run(setAccountSettings, {
      account,
      wrapper: "ikze",
      importer: "xtb",
      mappingYaml: null,
    });
    expect(same.ok && [same.value.changed, same.events.length]).toEqual([false, 0]);
    expect(accountSettings(read, account)).toMatchObject({ wrapper: "ikze", importer: "xtb" });
    const other = otherVault().run(setAccountSettings, { account, wrapper: "ike" });
    expect(other.ok ? "ok" : other.reason).toBe("no_account");
  });

  it("remembers the importer and keeps the mapping unless generic_csv or a mapping is given", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    const account = brokerage(v);
    const remember = (importer: string, mappingYaml?: string) =>
      v.value(rememberAccountImporter, {
        account,
        importer,
        ...(mappingYaml === undefined ? {} : { mappingYaml }),
      }).changed;
    expect(remember("generic_csv", "columns: {}")).toBe(true);
    expect(accountSettings(read, account)).toMatchObject({
      importer: "generic_csv",
      mappingYaml: "columns: {}",
    });
    expect(remember("generic_csv")).toBe(false); // an unchanged re-import writes nothing
    expect(remember("xtb")).toBe(true);
    expect(accountSettings(read, account)).toMatchObject({
      importer: "xtb",
      mappingYaml: "columns: {}",
    });
    expect(remember("xtb", "other: 1")).toBe(true); // a given mapping is stored with any importer
    expect(accountSettings(read, account).mappingYaml).toBe("other: 1");
    const out = otherVault().run(rememberAccountImporter, { account, importer: "xtb" });
    expect(out.ok ? "ok" : out.reason).toBe("no_account");
  });
});
