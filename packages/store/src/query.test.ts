// Live queries over the store (data-flow.md "Reading"): a watched query re-runs exactly when an apply
// touched a table it read, follows a read set that depends on its data, and keeps a failing run away
// from the apply that triggered it. Synthetic data only.
import { describe, expect, it } from "vitest";
import { createProfile, openAccount, renameProfile } from "./core/commands.js";
import { profile } from "./core/index.js";
import { defineQuery, queryKey, runQuery, watchQuery } from "./query.js";
import { run, testEnv } from "./testing/commands.js";
import { openTestStore } from "./testing/store.js";

const profileName = defineQuery({
  id: "test.profileName",
  run: (read) => read<{ name: string }>("SELECT name FROM profiles")[0]?.name ?? null,
});

const accountCount = defineQuery({
  id: "test.accountCount",
  run: (read) => read<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")[0]?.n ?? 0,
});

describe("queries", () => {
  it("key by id and canonical args, default to the vault scope", () => {
    const byBank = defineQuery({
      id: "test.byBank",
      run: (_read, args: { bank: string; live: boolean }) => args.bank,
    });
    expect(byBank.scope).toBe("vault");
    expect(queryKey(byBank, { bank: "mbank", live: true })).toBe(
      queryKey(byBank, { live: true, bank: "mbank" }),
    );
    expect(queryKey(profileName, undefined)).toBe("test.profileName:null");
  });

  it("report the tables a run read", () => {
    const store = openTestStore();
    expect([...runQuery(store, profileName, undefined).tables]).toEqual(["profiles"]);
  });

  it("core.profile decodes the vault's profile", () => {
    const store = openTestStore();
    expect(runQuery(store, profile, undefined).value).toBeNull();
    run(store, testEnv(), createProfile, { slug: "a", name: "Ala", baseCurrency: "EUR" });
    expect(runQuery(store, profile, undefined).value).toEqual({
      name: "Ala",
      baseCurrency: "EUR",
      mcpPrivacy: "strict",
    });
  });
});

describe("watchQuery", () => {
  it("re-runs after an apply that touched a table it read, and only then", () => {
    const store = openTestStore();
    const env = testEnv();
    const names: (string | null)[] = [];
    const counts: number[] = [];
    const stopNames = watchQuery(store, profileName, undefined, {
      onValue: (v) => names.push(v),
      onError: (e) => {
        throw e;
      },
    });
    watchQuery(store, accountCount, undefined, {
      onValue: (v) => counts.push(v),
      onError: (e) => {
        throw e;
      },
    });
    expect(names).toEqual([null]); // first run is synchronous
    expect(run(store, env, createProfile, { slug: "a", name: "Ala" }).ok).toBe(true);
    expect(names).toEqual([null, "Ala"]);
    expect(counts).toEqual([0]); // accounts untouched
    expect(
      run(store, env, openAccount, { bank: "mbank", type: "checking", currency: "PLN" }).ok,
    ).toBe(true);
    expect(counts).toEqual([0, 1]);
    expect(names).toEqual([null, "Ala"]);
    stopNames();
    expect(run(store, env, renameProfile, { name: "Ola" }).ok).toBe(true);
    expect(names).toEqual([null, "Ala"]);
  });

  it("follows a read set that depends on the data", () => {
    const store = openTestStore();
    const env = testEnv();
    // Reads accounts only once a profile exists.
    const accountsOnceNamed = defineQuery({
      id: "test.accountsOnceNamed",
      run: (read) =>
        read("SELECT name FROM profiles").length === 0
          ? -1
          : (read<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")[0]?.n ?? 0),
    });
    const seen: number[] = [];
    watchQuery(store, accountsOnceNamed, undefined, {
      onValue: (v) => seen.push(v),
      onError: (e) => {
        throw e;
      },
    });
    run(store, env, createProfile, { slug: "a", name: "Ala" });
    run(store, env, openAccount, { bank: "mbank", type: "checking", currency: "PLN" });
    expect(seen).toEqual([-1, 0, 1]);
  });

  it("hands a failing run to the reader, never to the apply", () => {
    const store = openTestStore();
    const env = testEnv();
    const failing = defineQuery({
      id: "test.failing",
      run: (read) => {
        if (read("SELECT name FROM profiles").length > 0) throw new Error("decode failed");
        return "empty";
      },
    });
    const values: string[] = [];
    const errors: unknown[] = [];
    watchQuery(store, failing, undefined, {
      onValue: (v) => values.push(v),
      onError: (e) => errors.push(e),
    });
    expect(run(store, env, createProfile, { slug: "a", name: "Ala" }).ok).toBe(true);
    expect(values).toEqual(["empty"]);
    expect(errors).toHaveLength(1);
    // Still listening: the next change re-runs it.
    run(store, env, renameProfile, { name: "Ola" });
    expect(errors).toHaveLength(2);
  });
});
