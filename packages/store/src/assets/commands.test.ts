// Assets commands: manual positions (name key reuse, a removed one starts fresh, D-24.7), notes
// (cleanNote, no row for a null note, D-24.9), revaluation. Synthetic data only.
import { describe, expect, it } from "vitest";
import { createProfile, removeAccount } from "../core/commands.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { addManualPosition, cleanNote, updateAssetDetails } from "./commands.js";

function setup() {
  const store = openTestStore();
  const env = testEnv();
  run(store, env, createProfile, { slug: "dom", name: "Dom", modules: ["assets"] });
  return { store, env };
}

describe("assets commands", () => {
  it("edits valuation and note in one append, and refuses an invalid note without an append", () => {
    const { store, env } = setup();
    const opened = run(store, env, addManualPosition, {
      name: "Synthetic home",
      type: "property",
      value: "100",
      note: "before",
    });
    if (!opened.ok) throw new Error("synthetic asset refused");
    const before = store.read("SELECT COUNT(*) AS n FROM event_log")[0];
    expect(
      run(store, env, updateAssetDetails, {
        account: opened.value.account,
        value: "110",
        note: "x".repeat(501),
      }),
    ).toEqual({ ok: false, reason: "note_too_long" });
    expect(store.read("SELECT COUNT(*) AS n FROM event_log")[0]).toEqual(before);
    const edited = run(store, env, updateAssetDetails, {
      account: opened.value.account,
      value: "110",
      onDate: "2026-11-01",
      note: "after",
    });
    expect(edited.ok && edited.events.map((event) => event.type)).toEqual([
      "balance.recorded",
      "assetDetails.noteSet",
    ]);
    expect(store.read("SELECT amount FROM balances WHERE date = '2026-11-01'")).toEqual([
      { amount: "110" },
    ]);
    expect(store.read("SELECT note FROM asset_details")).toEqual([{ note: "after" }]);
  });
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

  it("notes: a blank note without a row emits nothing; null clears a note", () => {
    const { store, env } = setup();
    const a = run(store, env, addManualPosition, { name: "Auto", type: "vehicle", value: "1" });
    const account = a.ok ? a.value.account : "";
    expect(run(store, env, updateAssetDetails, { account, note: "   " })).toMatchObject({
      ok: true,
      events: [],
    });
    run(store, env, updateAssetDetails, { account, note: "garaż" });
    const cleared = run(store, env, updateAssetDetails, { account, note: null });
    expect(cleared.ok && cleared.events.map((e) => e.data.note)).toEqual([null]);
    expect(store.read("SELECT note FROM asset_details")).toEqual([{ note: null }]);
    expect(cleanNote("a\t b\n\nc")).toBe("a b c");
  });

  it("a removed asset cannot be revalued", () => {
    const { store, env } = setup();
    const flat = run(store, env, addManualPosition, { name: "Dom", type: "property", value: "5" });
    const property = flat.ok ? flat.value.account : "";
    run(store, env, removeAccount, { account: property });
    expect(run(store, env, updateAssetDetails, { account: property, value: "1" })).toEqual({
      ok: false,
      reason: "no_asset",
    });
  });
});
