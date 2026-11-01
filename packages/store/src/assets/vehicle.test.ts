// Python assets.service.set_vehicle: one transaction, name-key reuse and valuation before commit.
import { describe, expect, it } from "vitest";
import { runCommand, storeWriter } from "../command.js";
import { createProfile, removeAccount, renameAccount } from "../core/commands.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { setVehicle, vehicleAccount } from "./vehicle.js";

const input = {
  name: "Synthetic car",
  purchasePrice: "80000.0",
  purchaseDate: "2026-10-31",
  annualRate: "15.0",
  asOf: "2026-10-31",
};
function setup() {
  const store = openTestStore();
  const env = testEnv();
  run(store, env, createProfile, {
    slug: "synthetic",
    name: "Synthetic household",
    modules: [], // CLI writes do not require the profile's assets module to be enabled.
    baseCurrency: "USD",
  });
  return { store, env };
}

describe("atomic vehicle command", () => {
  it("appends account and curve once and publishes no half-created vehicle", () => {
    const { store, env } = setup();
    const visible: unknown[] = [];
    const stop = store.subscribe(["accounts", "depreciations"], () => {
      visible.push(
        store.read(
          "SELECT a.name, d.purchase_price FROM accounts a JOIN depreciations d ON d.account_id = a.id",
        ),
      );
    });
    let appends = 0;
    const writer = storeWriter(store);
    try {
      const result = runCommand(
        store,
        {
          append(events) {
            appends += 1;
            writer.append(events);
          },
        },
        setVehicle,
        input,
        env,
      );
      expect(result).toMatchObject({
        ok: true,
        value: { created: true, name: input.name, currency: "USD", value: "80000.0" },
      });
      expect(result.ok && result.events.map((event) => event.type)).toEqual([
        "account.opened",
        "depreciation.set",
      ]);
      expect(appends).toBe(1);
      expect(visible).toEqual([[{ name: input.name, purchase_price: "80000.0" }]]);
      expect(store.read("SELECT COUNT(*) AS n FROM balances")).toEqual([{ n: 0 }]);
    } finally {
      stop();
      store.detach();
    }
  });

  it("updates the curve while retaining an existing account's name and currency", () => {
    const { store, env } = setup();
    try {
      const first = run(store, env, setVehicle, input);
      if (!first.ok) throw new Error("synthetic vehicle refused");
      run(store, env, renameAccount, { account: first.value.account, name: "Renamed car" });
      const result = run(store, env, setVehicle, {
        ...input,
        purchasePrice: "90000.0",
        annualRate: "0.0",
        floor: "0.0",
        currency: "EUR",
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          account: first.value.account,
          created: false,
          name: "Renamed car",
          currency: "USD",
        },
      });
      expect(result.ok && result.events.map((event) => event.type)).toEqual(["depreciation.set"]);
      expect(store.read("SELECT purchase_price, annual_rate, floor FROM depreciations")).toEqual([
        { purchase_price: "90000.0", annual_rate: "0.0", floor: "0.0" },
      ]);
    } finally {
      store.detach();
    }
  });

  it("starts a fresh account after removal and preserves the removed curve", () => {
    const { store, env } = setup();
    try {
      const first = run(store, env, setVehicle, input);
      if (!first.ok) throw new Error("synthetic vehicle refused");
      run(store, env, removeAccount, { account: first.value.account });
      expect(vehicleAccount(store.read.bind(store), input.name)).toBeUndefined();
      const next = run(store, env, setVehicle, { ...input, currency: "PLN" });
      expect(next.ok && next.value.created).toBe(true);
      expect(next.ok && next.value.account).not.toBe(first.value.account);
      expect(vehicleAccount(store.read.bind(store), input.name)?.currency).toBe("PLN");
      expect(store.read("SELECT COUNT(*) AS n FROM depreciations")).toEqual([{ n: 2 }]);
    } finally {
      store.detach();
    }
  });

  it("a valuation failure appends nothing, including when replacing an existing curve", () => {
    const { store, env } = setup();
    try {
      const invalid = { ...input, annualRate: "101.0", purchaseDate: "2026-10-01" };
      expect(() => run(store, env, setVehicle, invalid)).toThrow("no real value");
      expect(store.read("SELECT COUNT(*) AS n FROM accounts")).toEqual([{ n: 0 }]);
      run(store, env, setVehicle, input);
      expect(() => run(store, env, setVehicle, invalid)).toThrow("no real value");
      expect(store.read("SELECT annual_rate FROM depreciations")).toEqual([
        { annual_rate: "15.0" },
      ]);
    } finally {
      store.detach();
    }
  });

  it("keeps an empty name's Python fallback and values a future purchase at zero", () => {
    const { store, env } = setup();
    try {
      const result = run(store, env, setVehicle, {
        ...input,
        name: "",
        purchaseDate: "2026-11-01",
      });
      expect(result).toMatchObject({ ok: true, value: { name: "manual", value: "0.00" } });
      expect(vehicleAccount(store.read.bind(store), "")?.externalId).toBe("vehicle:");
    } finally {
      store.detach();
    }
  });
});
