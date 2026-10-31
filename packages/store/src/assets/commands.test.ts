// Assets commands (S24 5): manual positions (name key reuse, a removed one starts fresh, D-24.7),
// notes (clean_note, no row for a null note, D-24.9), revalue, depreciation (Python
// assets/service.py). Synthetic data only.
import { describe, expect, it } from "vitest";
import { createProfile, removeAccount } from "../core/commands.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { addManualPosition, cleanNote, revalue, setDepreciation, setNote } from "./commands.js";

function setup() {
  const store = openTestStore();
  const env = testEnv();
  run(store, env, createProfile, { slug: "dom", name: "Dom", modules: ["assets"] });
  return { store, env };
}

describe("assets commands", () => {
  it("a position: account + manual balance (today) + note; the same name updates it", () => {
    const { store, env } = setup();
    const a = run(store, env, addManualPosition, {
      name: "Mieszkanie",
      type: "property",
      value: "650000",
      note: " na\n Mokotowie ",
    });
    expect(a.ok && a.events.map((e) => e.type)).toEqual([
      "account.opened",
      "balance.recorded",
      "assetDetails.noteSet",
    ]);
    const b = run(store, env, addManualPosition, {
      name: "Mieszkanie",
      type: "property",
      value: 700000,
      onDate: "2026-11-30",
    });
    expect(b.ok && b.value.account).toBe(a.ok && a.value.account);
    expect(store.read("SELECT date, amount, currency FROM balances ORDER BY date")).toEqual([
      { date: "2026-10-31", amount: "650000", currency: "PLN" },
      { date: "2026-11-30", amount: "700000", currency: "PLN" },
    ]);
    expect(store.read("SELECT note FROM asset_details")).toEqual([{ note: "na Mokotowie" }]);
  });

  it("a removed position is not revived by a new one of its name", () => {
    const { store, env } = setup();
    const a = run(store, env, addManualPosition, { name: "Działka", type: "property", value: "1" });
    const first = a.ok ? a.value.account : "";
    run(store, env, removeAccount, { account: first });
    const b = run(store, env, addManualPosition, { name: "Działka", type: "property", value: "2" });
    expect(b.ok && b.value.created).toBe(true);
    expect(store.read("SELECT external_id FROM accounts WHERE gid = ?", first)).toEqual([
      { external_id: `manual:Działka~${first}` },
    ]);
  });

  it("notes: a null note without a row emits nothing; too long is refused", () => {
    const { store, env } = setup();
    const a = run(store, env, addManualPosition, { name: "Auto", type: "vehicle", value: "1" });
    const account = a.ok ? a.value.account : "";
    expect(run(store, env, setNote, { account, note: "   " })).toMatchObject({
      ok: true,
      events: [],
    });
    expect(run(store, env, setNote, { account, note: "x".repeat(501) })).toEqual({
      ok: false,
      reason: "note_too_long",
    });
    run(store, env, setNote, { account, note: "garaż" });
    const cleared = run(store, env, setNote, { account, note: null });
    expect(cleared.ok && cleared.events.map((e) => e.data.note)).toEqual([null]);
    expect(store.read("SELECT note FROM asset_details")).toEqual([{ note: null }]);
    expect(cleanNote("a\t b\n\nc")).toBe("a b c");
  });

  it("revalue and depreciation on visible accounts only", () => {
    const { store, env } = setup();
    const a = run(store, env, addManualPosition, { name: "Auto", type: "vehicle", value: "50000" });
    const account = a.ok ? a.value.account : "";
    run(store, env, setDepreciation, {
      account,
      purchasePrice: "80000",
      purchaseDate: "2024-03-01",
      annualRate: 15,
    });
    run(store, env, revalue, { account, value: "48000", onDate: "2026-11-01" });
    expect(store.read("SELECT purchase_price, annual_rate, floor FROM depreciations")).toEqual([
      { purchase_price: "80000", annual_rate: "15", floor: null },
    ]);
    expect(store.read("SELECT COUNT(*) AS n FROM balances")).toEqual([{ n: 2 }]);
    run(store, env, removeAccount, { account });
    expect(run(store, env, revalue, { account, value: "1" })).toEqual({
      ok: false,
      reason: "no_account",
    });
  });
});
