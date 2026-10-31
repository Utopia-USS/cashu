// Genesis counters: keys only, sorted JSON snapshot, per-vault buckets.
import { describe, expect, it } from "vitest";
import { GenesisCounters, GenesisError } from "./report.js";

describe("GenesisCounters", () => {
  it("adds global and per-vault counts and renders sorted keys", () => {
    const c = new GenesisCounters();
    c.add("transactions", "bad_enum");
    c.add("balances", "unscoped", 2);
    c.add("balances", "bad_decimal");
    c.add("balances", "json_float", 0);
    c.addVault(1, "inv_signals", "ack_without_decision");
    c.addVault(0, "accounts", "iban_invalid", 3);
    const snap = c.snapshot();
    expect(JSON.stringify(snap)).toBe(
      JSON.stringify({
        global: { balances: { bad_decimal: 1, unscoped: 2 }, transactions: { bad_enum: 1 } },
        vaults: {
          0: { accounts: { iban_invalid: 3 } },
          1: { inv_signals: { ack_without_decision: 1 } },
        },
      }),
    );
    expect(c.get("balances", "unscoped")).toBe(2);
    expect(c.get("accounts", "iban_invalid", 0)).toBe(3);
    expect(c.get("accounts", "iban_invalid")).toBe(0);
  });

  it("refuses keys that are not code identifiers, so no value can become a key", () => {
    const c = new GenesisCounters();
    expect(() => c.add("balances", "Anna Kowalska")).toThrow();
    expect(() => c.add("PL61 1090", "unscoped")).toThrow();
    expect(() => c.add("balances", "unscoped", -1)).toThrow();
    expect(() => c.addVault(-1, "balances", "unscoped")).toThrow();
  });
});

describe("GenesisError", () => {
  it("carries the code and exit code 65", () => {
    const e = new GenesisError("unsupported_schema", "no alembic_version table");
    expect([e.code, e.exitCode, e.name, e.message]).toEqual([
      "unsupported_schema",
      65,
      "GenesisError",
      "no alembic_version table",
    ]);
  });
});
