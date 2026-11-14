import { describe, expect, it } from "vitest";
import { createProfile, openAccount } from "../core/commands.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { addManualPosition, updateAssetDetails } from "./commands.js";
import { createOverviewAsset } from "./overview.js";

const base = {
  name: " Synthetic   home ",
  type: "property" as const,
  value: "100",
  currency: "PLN",
  onDate: "2026-10-01",
  note: "source note",
};

describe("dashboard asset boundary", () => {
  it("normalizes names, refuses live cross-kind duplicates and preserves the log on refusal", () => {
    const store = openTestStore();
    const env = testEnv();
    run(store, env, createProfile, { slug: "synthetic", name: "Synthetic", modules: ["assets"] });
    const first = run(store, env, createOverviewAsset, base);
    expect(first.ok).toBe(true);
    const before = store.read("SELECT COUNT(*) AS n FROM event_log");
    expect(run(store, env, createOverviewAsset, { ...base, name: "Synthetic home" })).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect(
      run(store, env, createOverviewAsset, {
        name: "Synthetic home",
        type: "vehicle",
        currency: "PLN",
        curve: { purchasePrice: "200", purchaseDate: "2026-01-01", annualRate: "15", floor: null },
      }),
    ).toEqual({ ok: false, reason: "name_taken" });
    expect(store.read("SELECT COUNT(*) AS n FROM event_log")).toEqual(before);
    expect(store.read("SELECT name FROM accounts WHERE external_id LIKE 'manual:%'")).toEqual([
      { name: "Synthetic home" },
    ]);
  });

  it("rejects future or invalid curves and non-asset edits without an event", () => {
    const store = openTestStore();
    const env = testEnv();
    run(store, env, createProfile, { slug: "synthetic", name: "Synthetic", modules: ["assets"] });
    const checking = run(store, env, openAccount, {
      bank: "manual",
      type: "checking",
      currency: "PLN",
    });
    if (!checking.ok) throw new Error("synthetic account refused");
    const input = {
      name: "Synthetic car",
      type: "vehicle" as const,
      currency: "PLN",
      curve: { purchasePrice: "200", purchaseDate: "2026-01-01", annualRate: "15", floor: null },
    };
    const before = store.read("SELECT COUNT(*) AS n FROM event_log");
    expect(
      run(store, env, createOverviewAsset, {
        ...input,
        curve: { ...input.curve, purchaseDate: "2027-01-01" },
      }),
    ).toEqual({ ok: false, reason: "invalid_depreciation" });
    expect(
      run(store, env, createOverviewAsset, {
        ...input,
        curve: { ...input.curve, annualRate: "101" },
      }),
    ).toEqual({ ok: false, reason: "invalid_depreciation" });
    expect(
      run(store, env, createOverviewAsset, { ...input, curve: { ...input.curve, floor: "201" } }),
    ).toEqual({ ok: false, reason: "invalid_depreciation" });
    expect(run(store, env, createOverviewAsset, { ...base, value: "-1" })).toEqual({
      ok: false,
      reason: "invalid_valuation",
    });
    expect(
      run(store, env, updateAssetDetails, { account: checking.value.account, value: "12" }),
    ).toEqual({ ok: false, reason: "no_asset" });
    expect(store.read("SELECT COUNT(*) AS n FROM event_log")).toEqual(before);
    const vehicle = run(store, env, createOverviewAsset, input);
    if (!vehicle.ok) throw new Error("synthetic vehicle refused");
    const after = store.read("SELECT COUNT(*) AS n FROM event_log");
    expect(
      run(store, env, updateAssetDetails, {
        account: vehicle.value.account,
        depreciation: { ...input.curve, floor: "201" },
      }),
    ).toEqual({ ok: false, reason: "invalid_depreciation" });
    expect(store.read("SELECT COUNT(*) AS n FROM event_log")).toEqual(after);
    const legacy = run(store, env, addManualPosition, {
      name: "Legacy manual vehicle type",
      type: "vehicle",
      value: "3",
    });
    if (!legacy.ok) throw new Error("synthetic manual position refused");
    expect(
      run(store, env, updateAssetDetails, { account: legacy.value.account, value: "4" }).ok,
    ).toBe(true);
  });
});
