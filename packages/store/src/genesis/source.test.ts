// S26 spec 2.2 (schema versions, 0025 backfill), 2.3 (row decoding, skip + count), 2.4 (profile
// scoping), 3.1 (tables read in a stable key order). Synthetic rows only.
import { describe, expect, it } from "vitest";
import type { SqlDriver } from "../sql/driver.js";
import { GenesisCounters, GenesisError } from "./report.js";
import { type GenesisFiles, type PythonSource, readPythonSource, scopeProfiles } from "./source.js";
import { PythonRows } from "./testing/pythonRows.js";
import { pythonDb } from "./testing/pythonSchema.js";

const NO_FILES: GenesisFiles = { read: () => undefined, list: () => [] };

function read(driver: SqlDriver, counters = new GenesisCounters()): PythonSource {
  return readPythonSource(driver, NO_FILES, counters);
}

function refusal(fn: () => unknown): GenesisError | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof GenesisError) return e;
    throw e;
  }
  return undefined;
}

describe("readPythonSource: schema", () => {
  it.each(["0025_topic_view_sources", "0026_thesis_exit_plan_changed_at", "0027_sync_outbox"])(
    "accepts %s",
    (version) => {
      const driver = pythonDb(version === "0025_topic_view_sources" ? "0025" : "0026");
      driver.prepare("UPDATE alembic_version SET version_num = ?").run(version);
      expect(read(driver).schema).toBe(version);
    },
  );

  it("accepts 0028 (sync tables present, not read)", () => {
    expect(read(pythonDb("0028")).schema).toBe("0028_sync_inbound");
  });

  it.each(["0024_topic_market_view", "0029_future"])("refuses %s with exit code 65", (version) => {
    const driver = pythonDb();
    driver.prepare("UPDATE alembic_version SET version_num = ?").run(version);
    const e = refusal(() => read(driver));
    expect(e?.code).toBe("unsupported_schema");
    expect(e?.exitCode).toBe(65);
  });

  it("refuses a database without alembic_version, or with two rows", () => {
    const none = pythonDb();
    none.exec("DROP TABLE alembic_version");
    expect(refusal(() => read(none))?.code).toBe("unsupported_schema");
    const two = pythonDb();
    two.exec("INSERT INTO alembic_version VALUES ('0025_topic_view_sources')");
    expect(refusal(() => read(two))?.code).toBe("unsupported_schema");
  });

  it("refuses a missing table or column instead of assuming it", () => {
    const table = pythonDb();
    table.exec("DROP TABLE reviews");
    expect(refusal(() => read(table))?.message).toBe("missing table reviews");
    const column = pythonDb();
    column.exec("ALTER TABLE accounts DROP COLUMN removed_at");
    expect(refusal(() => read(column))?.message).toBe("missing column accounts.removed_at");
    const exitPlan = pythonDb("0025");
    exitPlan
      .prepare("UPDATE alembic_version SET version_num = ?")
      .run("0026_thesis_exit_plan_changed_at");
    expect(refusal(() => read(exitPlan))?.message).toBe(
      "missing column inv_theses.exit_plan_changed_at",
    );
  });
});

describe("readPythonSource: rows", () => {
  it.each(["0025", "0026", "0028"] as const)(
    "reads one default row of every table on %s",
    (schema) => {
      const driver = pythonDb(schema);
      new PythonRows(driver).insertEveryTable();
      const counters = new GenesisCounters();
      const { schema: _version, files: _files, ...tables } = read(driver, counters);
      expect(Object.keys(tables)).toHaveLength(35);
      for (const [name, rows] of Object.entries(tables))
        expect([name, rows.length]).toEqual([name, 1]);
      expect(counters.snapshot().global).toEqual({});
      const scopes = scopeProfiles(read(driver), counters);
      expect(scopes).toHaveLength(1);
      expect(counters.snapshot().global).toEqual({});
    },
  );

  it("decodes every column kind", () => {
    const driver = pythonDb();
    const rows = new PythonRows(driver);
    rows.insert("profiles", { created_at: "2026-03-04 05:06:07.000001" });
    rows.insert("accounts", { profile_id: 1, iban: "PL00TEST", active: 1 });
    rows.insert("balances", { account_id: 1, amount: "1.5E+3", source: "OPEN_BANKING" });
    rows.insert("transactions", { account_id: 1, raw: '{"title": "x", "n": 2.5}' });
    rows.insert("inv_signals", { payload: '{"score": 0.25, "id": 9007199254740993}' });
    const counters = new GenesisCounters();
    const s = read(driver, counters);
    expect(s.profiles[0]?.createdAt).toBe("2026-03-04T05:06:07.000001Z");
    expect(s.accounts[0]).toMatchObject({
      id: 1,
      profileId: 1,
      iban: "PL00TEST",
      active: true,
      removedAt: null,
    });
    expect(s.balances[0]).toMatchObject({
      amount: "1500",
      source: "open_banking",
      date: "2026-01-02",
    });
    expect(s.transactions[0]?.raw).toEqual({ title: "x", n: 2.5 });
    expect(s.transactions[0]?.source).toBe("csv");
    expect(s.invSignals[0]?.payload).toEqual({ score: 0.25, id: 9007199254740992 });
    expect(counters.get("transactions", "json_float")).toBe(1);
    expect(counters.get("inv_signals", "json_float")).toBe(1);
    expect(counters.get("inv_signals", "json_big_int")).toBe(1);
  });

  it("reads JSON null of a NOT NULL column as the model default, of a nullable one as null", () => {
    const driver = pythonDb();
    const rows = new PythonRows(driver);
    rows.insert("alerts", { params: "null" });
    rows.insert("inv_rule_runs", { errors: "null" });
    rows.insert("transactions", { raw: "null" });
    rows.insert("research_notes", { details: null });
    const s = read(driver);
    expect(s.alerts[0]?.params).toEqual({});
    expect(s.invRuleRuns[0]?.errors).toEqual([]);
    expect(s.transactions[0]?.raw).toBeNull();
    expect(s.researchNotes[0]?.details).toBeNull();
  });

  it("orders every table by its unique key", () => {
    const driver = pythonDb();
    const rows = new PythonRows(driver);
    rows.insert("accounts", { id: 5 });
    rows.insert("accounts", { id: 2 });
    rows.insert("profile_modules", { profile_id: 2, module_id: "budget" });
    rows.insert("profile_modules", { profile_id: 1, module_id: "loans" });
    rows.insert("profile_modules", { profile_id: 1, module_id: "assets" });
    rows.insert("inv_decision_signals", { decision_id: 2, signal_id: 1 });
    rows.insert("inv_decision_signals", { decision_id: 1, signal_id: 7 });
    rows.insert("inv_decision_signals", { decision_id: 1, signal_id: 3 });
    const s = read(driver);
    expect(s.accounts.map((a) => a.id)).toEqual([2, 5]);
    expect(s.profileModules.map((m) => `${m.profileId}:${m.moduleId}`)).toEqual([
      "1:assets",
      "1:loans",
      "2:budget",
    ]);
    expect(s.invDecisionSignals.map((l) => `${l.decisionId}:${l.signalId}`)).toEqual([
      "1:3",
      "1:7",
      "2:1",
    ]);
  });

  it("skips a row that does not decode and counts (table, reason)", () => {
    const driver = pythonDb();
    const rows = new PythonRows(driver);
    rows.insert("balances", { amount: "NaN" });
    rows.insert("balances", { amount: "2.00", date: "2026-01-03" });
    rows.insert("transactions", { source: "csv" });
    rows.insert("alerts", { params: '{"x": NaN}' });
    rows.insert("accounts", { created_at: "yesterday" });
    rows.insert("loans", { start_date: "2026-02-30" });
    rows.insert("inv_instruments", { needs_classification: 2 });
    const counters = new GenesisCounters();
    const s = read(driver, counters);
    expect(s.balances.map((b) => b.amount)).toEqual(["2.00"]);
    expect(
      [s.transactions, s.alerts, s.accounts, s.loans, s.invInstruments].map((t) => t.length),
    ).toEqual([0, 0, 0, 0, 0]);
    expect(counters.snapshot().global).toEqual({
      accounts: { bad_timestamp: 1 },
      alerts: { bad_json: 1 },
      balances: { bad_decimal: 1 },
      inv_instruments: { bad_bool: 1 },
      loans: { bad_date: 1 },
      transactions: { bad_enum: 1 },
    });
  });
});

describe("readPythonSource: 0025 exit_plan_changed_at backfill", () => {
  function seed(driver: SqlDriver): void {
    const rows = new PythonRows(driver);
    rows.insert("inv_theses", {
      exit_plan: "Sprzedaj przy 2x",
      updated_at: "2026-05-06 07:08:09.100000",
    });
    rows.insert("inv_theses", { exit_plan: "", updated_at: "2026-05-06 07:08:09.200000" });
    rows.insert("inv_theses", { exit_plan: null });
  }

  it("mirrors migration 0026 so 0025 and the migrated copy read the same", () => {
    const old = pythonDb("0025");
    seed(old);
    const before = read(old);
    expect(before.invTheses.map((t) => t.exitPlanChangedAt)).toEqual([
      "2026-05-06T07:08:09.100000Z",
      null,
      null,
    ]);
    // Migration 0026 applied to the same database.
    old.exec(
      "ALTER TABLE inv_theses ADD COLUMN exit_plan_changed_at DATETIME;" +
        "UPDATE inv_theses SET exit_plan_changed_at = updated_at WHERE exit_plan IS NOT NULL AND exit_plan != '';" +
        "UPDATE alembic_version SET version_num = '0026_thesis_exit_plan_changed_at';",
    );
    const after = read(old);
    expect(after.schema).toBe("0026_thesis_exit_plan_changed_at");
    expect({ ...after, schema: "" }).toEqual({ ...before, schema: "" });
  });

  it("reads the stored column on 0026", () => {
    const driver = pythonDb("0026");
    new PythonRows(driver).insert("inv_theses", {
      exit_plan: "x",
      exit_plan_changed_at: "2026-01-01 00:00:00",
    });
    expect(read(driver).invTheses[0]?.exitPlanChangedAt).toBe("2026-01-01T00:00:00Z");
  });
});

describe("scopeProfiles", () => {
  function twoProfiles(): SqlDriver {
    const driver = pythonDb();
    const rows = new PythonRows(driver);
    rows.insert("profiles", { id: 2, slug: "piotr" });
    rows.insert("profiles", { id: 1, slug: "anna" });
    rows.insert("accounts", { id: 10, profile_id: 1 });
    rows.insert("accounts", { id: 20, profile_id: 2 });
    rows.insert("accounts", { id: 30, profile_id: 9 }); // profile missing
    rows.insert("balances", { account_id: 10 });
    rows.insert("balances", { account_id: 20 });
    rows.insert("balances", { account_id: 30 }); // through an unscoped account
    rows.insert("balances", { account_id: 99 }); // account missing
    rows.insert("inv_transactions", { account_id: 20 });
    rows.insert("inv_account_settings", { account_id: 10 });
    rows.insert("alerts", { profile_id: 2 });
    rows.insert("alerts", { profile_id: 9 });
    rows.insert("inv_decisions", { id: 5, profile_id: 2 });
    rows.insert("inv_decision_signals", { decision_id: 5, signal_id: 1 });
    rows.insert("inv_decision_signals", { decision_id: 6, signal_id: 1 }); // decision missing
    rows.insert("inv_instruments");
    rows.insert("inv_instrument_aliases", { instrument_id: 1 });
    return driver;
  }

  it("assigns every row to one profile, profiles in id order", () => {
    const counters = new GenesisCounters();
    const source = read(twoProfiles(), counters);
    const scopes = scopeProfiles(source, counters);
    expect(scopes.map((s) => s.profile.id)).toEqual([1, 2]);
    const [anna, piotr] = scopes;
    expect(anna?.accounts.map((a) => a.id)).toEqual([10]);
    expect(anna?.balances.map((b) => b.accountId)).toEqual([10]);
    expect(anna?.invAccountSettings.map((x) => x.accountId)).toEqual([10]);
    expect(anna?.alerts).toEqual([]);
    expect(piotr?.accounts.map((a) => a.id)).toEqual([20]);
    expect(piotr?.balances.map((b) => b.accountId)).toEqual([20]);
    expect(piotr?.invTransactions.map((t) => t.accountId)).toEqual([20]);
    expect(piotr?.alerts.map((a) => a.profileId)).toEqual([2]);
    expect(piotr?.invDecisionSignals.map((l) => l.decisionId)).toEqual([5]);
    // Instruments and aliases are global (spec 4.6), not on a scope.
    expect(source.invInstruments).toHaveLength(1);
    expect(source.invInstrumentAliases).toHaveLength(1);
    expect(Object.keys(anna ?? {})).not.toContain("invInstruments");
  });

  it("counts unassignable rows as unscoped, with keys only", () => {
    const counters = new GenesisCounters();
    scopeProfiles(read(twoProfiles(), counters), counters);
    expect(counters.snapshot()).toEqual({
      global: {
        accounts: { unscoped: 1 },
        alerts: { unscoped: 1 },
        balances: { unscoped: 2 },
        inv_decision_signals: { unscoped: 1 },
      },
      vaults: {},
    });
  });
});
