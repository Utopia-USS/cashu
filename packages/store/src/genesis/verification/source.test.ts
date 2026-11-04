import { describe, expect, it } from "vitest";
import { PythonRows } from "../testing/pythonRows.js";
import { pythonDb } from "../testing/pythonSchema.js";
import { assertSourceSchemaCoverage, VerificationSchemaError } from "./source.js";

describe("legacy source schema coverage", () => {
  it.each([
    ["0025", "0025_topic_view_sources"],
    ["0026", "0026_thesis_exit_plan_changed_at"],
    ["0029", "0029_sync_inbound"],
  ] as const)("accounts for every mapped column of %s", (schema, revision) => {
    const db = pythonDb(schema);
    try {
      expect(() => assertSourceSchemaCoverage(db, revision)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("refuses a new financial column before any mapping can omit it", () => {
    const db = pythonDb("0029");
    try {
      db.exec("ALTER TABLE accounts ADD COLUMN new_money_field VARCHAR");
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).toThrowError(
        new VerificationSchemaError(),
      );
    } finally {
      db.close();
    }
  });

  it("covers embedded decision links and refuses cross-profile links", () => {
    const db = pythonDb("0029");
    try {
      const rows = new PythonRows(db);
      rows.insert("profiles", { slug: "alpha" });
      rows.insert("profiles", { slug: "beta" });
      const ownSignal = rows.insert("inv_signals", { profile_id: 1, dedup_key: "own" });
      const otherSignal = rows.insert("inv_signals", { profile_id: 2, dedup_key: "other" });
      const decision = rows.insert("inv_decisions", { profile_id: 1, signal_id: ownSignal });
      rows.insert("inv_decision_signals", { decision_id: decision, signal_id: ownSignal });
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).not.toThrow();
      rows.insert("inv_decision_signals", { decision_id: decision, signal_id: otherSignal });
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).toThrowError(
        new VerificationSchemaError(),
      );
    } finally {
      db.close();
    }
  });

  it("accepts exact ephemeral change history even with a stale profile and refuses schema drift", () => {
    const db = pythonDb("0029");
    try {
      db.prepare(
        "INSERT INTO change_events(id,ts,profile_id,entity,op,ref,payload) VALUES (?,?,?,?,?,?,?)",
      ).run(1, "2026-01-02 03:04:05.000000", 999, "prices", "update", null, '{"count":1}');
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).not.toThrow();
      db.exec("ALTER TABLE change_events ADD COLUMN financial_amount VARCHAR");
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).toThrowError(
        new VerificationSchemaError(),
      );
    } finally {
      db.close();
    }
  });

  it("accepts exact profile-bound MCP audit history and refuses orphaned audit rows", () => {
    const db = pythonDb("0029");
    try {
      const rows = new PythonRows(db);
      rows.insert("profiles", { slug: "synthetic" });
      db.prepare(
        "INSERT INTO mcp_calls(id,profile_id,tool,privacy,called_at,args,outcome,error_kind,duration_ms) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        7,
        1,
        "synthetic.tool",
        "strict",
        "2026-01-02 03:04:05.000000",
        '{"flag":"boolean"}',
        "ok",
        null,
        12,
      );
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).not.toThrow();
      db.prepare("UPDATE mcp_calls SET profile_id=? WHERE id=?").run(999, 7);
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).toThrowError(
        new VerificationSchemaError(),
      );
    } finally {
      db.close();
    }
  });

  it("classifies installed Python connector metadata without trusting its approval", () => {
    const db = pythonDb("0029");
    try {
      db.prepare(
        `INSERT INTO connectors(id,name,version,module,kind,manifest_json,content_sha256,
          interpreter_path,status,installed_at,updated_at,source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        "synthetic.connector",
        "Synthetic",
        "1",
        "budget",
        "file",
        "{}",
        "00".repeat(32),
        "/synthetic/python",
        "approved",
        "2026-01-02 03:04:05.000000",
        "2026-01-02 03:04:05.000000",
        "cli",
      );
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).not.toThrow();
      db.exec("ALTER TABLE connectors ADD COLUMN secret_token TEXT");
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).toThrowError(
        new VerificationSchemaError(),
      );
    } finally {
      db.close();
    }
  });

  it("accepts unscoped connector run history while refusing an unknown named profile", () => {
    const db = pythonDb("0029");
    try {
      db.prepare(
        `INSERT INTO connector_runs(id,connector_id,command,started_at,duration_ms,
          outcome,records,bytes_in,bytes_out,denied_hosts_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(3, "synthetic-connector", "check", "2026-01-02 03:04:05.000000", 20,
        "ok", 0, 0, 0, "[]");
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).not.toThrow();
      db.prepare("UPDATE connector_runs SET profile_id=? WHERE id=?").run(999, 3);
      expect(() => assertSourceSchemaCoverage(db, "0029_sync_inbound")).toThrowError(
        new VerificationSchemaError(),
      );
    } finally {
      db.close();
    }
  });
});
