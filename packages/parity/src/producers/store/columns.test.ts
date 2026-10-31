/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUNDTRIP_COLUMNS } from "./columns.ts";

const STORE_PY = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "parity",
  "python",
  "checks",
  "store.py",
);

/** `ROUNDTRIP_COLUMNS` of store.py: `"table": ("col", ...)` entries, strings only. */
function pythonColumns(): [string, string[]][] {
  const source = readFileSync(STORE_PY, "utf8");
  const start = source.indexOf("ROUNDTRIP_COLUMNS: dict");
  const end = source.indexOf("\n}\n", start);
  expect(start, "ROUNDTRIP_COLUMNS in store.py").toBeGreaterThan(0);
  const block = source.slice(source.indexOf("{", start) + 1, end);
  return [...block.matchAll(/"([a-z_]+)": \(([^)]*)\)/g)].map((m) => [
    m[1] as string,
    [...(m[2] as string).matchAll(/"([a-z_0-9]+)"/g)].map((c) => c[1] as string),
  ]);
}

describe("ROUNDTRIP_COLUMNS", () => {
  it("is a verbatim copy of parity/python/checks/store.py", () => {
    const py = pythonColumns();
    expect(py.length).toBeGreaterThan(30);
    expect(Object.entries(ROUNDTRIP_COLUMNS)).toEqual(py);
  });

  it("never compares row ids, profile ids, id-coupled hashes or device-local state", () => {
    for (const [table, columns] of Object.entries(ROUNDTRIP_COLUMNS)) {
      for (const banned of ["id", "profile_id", "dedup_hash", "last_run_at", "backoff_until"]) {
        expect(columns, table).not.toContain(banned);
      }
    }
    expect(ROUNDTRIP_COLUMNS.transactions).not.toContain("is_internal_transfer");
    expect(ROUNDTRIP_COLUMNS.alerts).not.toContain("status");
    expect(ROUNDTRIP_COLUMNS.inv_decisions).toContain("signals");
  });
});
