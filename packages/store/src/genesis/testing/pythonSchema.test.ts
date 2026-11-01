// The synthetic Python-schema DDL matches a fresh `cashu init-db` database (committed listing).
import { describe, expect, it } from "vitest";
import { PythonRows } from "./pythonRows.js";
import { headListing, pythonDb, schemaListing } from "./pythonSchema.js";

const isSync = (line: string) => line.startsWith("sync_");
const EXIT_PLAN = "inv_theses.exit_plan_changed_at:";
const ALERT_TAG = "alerts.tag:";

describe("python schema DDL", () => {
  it("0029 equals the head listing", () => {
    expect(schemaListing(pythonDb("0029"))).toEqual(headListing());
  });

  it("0026 equals the head listing minus the sync tables and alerts.tag", () => {
    const expected = headListing().filter((l) => !isSync(l) && !l.startsWith(ALERT_TAG));
    expect(schemaListing(pythonDb("0026"))).toEqual(expected);
  });

  it("0025 lacks inv_theses.exit_plan_changed_at too", () => {
    const expected = headListing().filter(
      (l) => !isSync(l) && !l.startsWith(ALERT_TAG) && !l.startsWith(EXIT_PLAN),
    );
    expect(schemaListing(pythonDb("0025"))).toEqual(expected);
  });

  it("sets the alembic version", () => {
    const row = pythonDb("0025").prepare("SELECT version_num FROM alembic_version").get();
    expect(row).toEqual({ version_num: "0025_topic_view_sources" });
  });
});

describe("PythonRows", () => {
  it("inserts a default row into every table genesis reads, on 0025 too", () => {
    for (const schema of ["0025", "0026"] as const) {
      const rows = new PythonRows(pythonDb(schema));
      expect(rows.insert("profiles")).toBe(1);
      expect(rows.insert("inv_theses", { exit_plan: "plan" })).toBe(1);
      expect(rows.insert("inv_decision_signals", { decision_id: 3, signal_id: 4 })).toBe(1);
    }
  });

  it("overrides defaults and keeps an explicit null", () => {
    const driver = pythonDb();
    const rows = new PythonRows(driver);
    rows.insert("accounts", { iban: "PL00", active: 0, removed_at: null });
    expect(driver.prepare("SELECT iban, active, removed_at FROM accounts").get()).toEqual({
      iban: "PL00",
      active: 0,
      removed_at: null,
    });
  });
});
