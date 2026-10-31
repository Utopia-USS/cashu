/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digest, NaturalKeys, SPECS, type SqlValue } from "./naturalKeys.ts";
import { PythonDb } from "./pythonDb.ts";
import { INVESTMENTS, type SyntheticDataset, syntheticDataset, TWO_PROFILES } from "./testing.ts";

const CANON_PY = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "parity",
  "python",
  "canon.py",
);

let ds: SyntheticDataset | undefined;
afterEach(() => ds?.dispose());

describe("natural keys", () => {
  it("digest matches canon.py _digest (vectors computed with Python)", () => {
    expect(digest(["demo-anna"])).toBe("d2bb2da074281623");
    expect(digest(["profile:abc", "mbank", "csv:1", "checking", "PLN", ""])).toBe(
      "f2a8667236648bd4",
    );
    expect(digest([""])).toBe("e3b0c44298fc1c14");
    expect(digest(["Łódź", "7"])).toBe("c008aa51dd817f7c");
  });

  it("SPECS is a verbatim copy of canon.py's", () => {
    // Python joins adjacent string literals; drop the quote-whitespace-quote seams first.
    const source = readFileSync(CANON_PY, "utf8").replace(/"\s*\n\s*"/g, "");
    const block = source.slice(source.indexOf("SPECS:"), source.indexOf("FIELD_TABLES:"));
    const pyTables = [...block.matchAll(/^ {4}"([a-z_]+)": \(/gm)].map((m) => m[1]);
    expect(Object.keys(SPECS)).toEqual(pyTables);
    for (const [table, spec] of Object.entries(SPECS)) {
      expect(block, table).toContain(`"${spec.sql}"`);
      expect(block, table).toContain(`"${spec.prefix}"`);
    }
  });

  it("keys reference other tables by key, number duplicates and count dangling refs", () => {
    ds = syntheticDataset(TWO_PROFILES);
    const db = PythonDb.open({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot });
    try {
      const profileB = `profile:${digest(["test-b"])}`;
      expect(db.keys.key("profiles", 1)).toBe(profileB);
      expect(db.keys.key("accounts", 1)).toBe(
        `account:${digest([profileB, "mbank", "csv:99114000000000000000000001", "checking", "PLN", ""])}`,
      );
      // No external id: the name is part of the key.
      expect(db.keys.key("accounts", 2)).toBe(
        `account:${digest([profileB, "manual", "", "cash", "PLN", "Gotówka"])}`,
      );
      // Same IBAN in another profile: another key (the profile is part of it).
      expect(db.keys.key("accounts", 5)).not.toBe(db.keys.key("accounts", 1));
      expect(db.keys.key("accounts", 99)).toBe("account:dangling-99");
      expect(db.keys.dangling).toBe(1);
    } finally {
      db.close();
    }
  });

  it("the roundtrip tables reference profiles, accounts and instruments by key", () => {
    ds = syntheticDataset(
      `${INVESTMENTS}
      INSERT INTO inv_account_settings VALUES (1, 'ike', 'xtb', NULL, NULL, NULL);
      INSERT INTO connector_bindings VALUES (1, 1, 1, 'test-connector', '{}', 0, NULL);`,
    );
    const db = PythonDb.open({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot });
    try {
      const k = db.keys;
      const profileA = k.key("profiles", 2);
      const etf = k.key("inv_instruments", 1);
      expect(k.key("inv_profile_instruments", 2)).toBe(
        `profile-instrument:${digest([profileA, etf])}`,
      );
      expect(k.key("inv_instrument_renames", 1)).toBe(
        `instrument-rename:${digest([profileA, "2026-06-01", etf, k.key("inv_instruments", 3)])}`,
      );
      expect(k.key("inv_account_settings", 1)).toBe(
        `account-settings:${digest([k.key("accounts", 1)])}`,
      );
      expect(k.key("inv_instrument_aliases", 2)).toBe(
        `instrument-alias:${digest([etf, "isin", "x"])}`,
      );
      expect(k.key("connector_bindings", 1)).toBe(
        `connector-binding:${digest([k.key("accounts", 1), "test-connector"])}`,
      );
      expect(k.dangling).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rows with equal parts get ~2, ~3 in id order", () => {
    const rows: SqlValue[][] = [
      [3n, "same"],
      [1n, "same"],
      [2n, "other"],
    ];
    const keys = new NaturalKeys({ rows: () => rows });
    expect(keys.key("profiles", 1)).toBe(`profile:${digest(["same"])}`);
    expect(keys.key("profiles", 3)).toBe(`profile:${digest(["same"])}~2`);
    expect(keys.count()).toEqual({ profiles: 3 });
  });

  it("refuses part types Python would print differently", () => {
    const keys = new NaturalKeys({ rows: () => [[1n, 1.5]] });
    expect(() => keys.key("profiles", 1)).toThrow(/unsupported SQLite type/);
  });
});
