/// <reference types="node" />
// Unit tests of the store.table roundtrip helpers (S26 spec 8.3): parity keys, canonical values,
// gid -> natural key mapping incl. dangling key parts, inverse builders and the modes. Synthetic only.
import { describe, expect, it } from "vitest";
import { dumps } from "../output.ts";
import { compareUtf8, json, sortRows, timestamp } from "./canonical.ts";
import { ROUNDTRIP_COLUMNS } from "./columns.ts";
import { type GenesisEvent, parityKeys, parityNow } from "./genesisRun.ts";
import { GidKeys } from "./gidKeys.ts";
import { cashExpenses, inverseRows } from "./inverse.ts";
import { JOURNAL_INVERSE } from "./inverseJournal.ts";
import { modeOf, PENDING_COLUMNS, PENDING_ROWS, VIEW_TABLES } from "./modes.ts";
import { STORE_TABLES } from "./tables.ts";

const ACC = "0a1b2c3d-0000-8000-8000-000000000001";
const INS = "0a1b2c3d-0000-8000-8000-000000000002";
/** A stand-in DET in the gid shape, unique per (table, numeric parts) in these tests. */
const det = (table: string, parts: readonly string[]) =>
  `${table.length.toString(16).padStart(8, "0")}-0000-8000-8000-${parts
    .join("")
    .replace(/[^0-9]/g, "")
    .padStart(12, "0")
    .slice(-12)}`;

const keysOf = () => {
  const sources = new Map([
    [ACC, { table: "accounts", localId: "7" }],
    [INS, { table: "inv_instruments", localId: "3" }],
  ]);
  return new GidKeys(
    { det: det as never, sources },
    { key: (table, id) => `${table}:${String(id)}` },
  );
};

describe("parity keys", () => {
  it("are fixed per slug: 32-hex vault, 32-byte salt, different slugs differ", () => {
    const a = parityKeys("test-a");
    expect(a.vault).toMatch(/^[0-9a-f]{32}$/);
    expect(a.salt.bytes.length).toBe(32);
    expect(parityKeys("test-a")).toEqual(a);
    expect(parityKeys("test-b").vault).not.toBe(a.vault);
  });

  it("give genesis a clock a year past the dataset clock", () => {
    expect(new Date(parityNow({ dataset: "demo" })).toISOString()).toBe("2027-10-02T12:00:00.000Z");
  });
});

describe("canonical values", () => {
  it("writes timestamps with six fraction digits and no Z, from event and view forms", () => {
    expect(timestamp("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000000");
    expect(timestamp("2026-01-02T03:04:05.12Z")).toBe("2026-01-02T03:04:05.120000");
    expect(timestamp("2026-01-02 03:04:05.123456")).toBe("2026-01-02T03:04:05.123456");
    expect(timestamp(null)).toBeNull();
    expect(() => timestamp("2026-01-02")).toThrow();
  });

  it("maps gids inside JSON and keeps integers exact", () => {
    const out = json({ a: [ACC, "x"], n: 2, f: 0.5 }, (s) => (s === ACC ? "account:k" : undefined));
    expect(dumps(out)).toBe('{"a":["account:k","x"],"f":0.5,"n":2}\n');
  });

  it("sorts rows by UTF-8 bytes like Python", () => {
    expect(compareUtf8("￿", "\u{1f600}")).toBeLessThan(0);
    const rows = sortRows([{ k: "b" }, { k: "a" }]);
    expect(rows.map((r) => r.k)).toEqual(["a", "b"]);
  });
});

describe("GidKeys", () => {
  it("maps refs and key parts to natural keys; a non-gid part stays", () => {
    const k = keysOf();
    expect(k.ref("accounts", ACC)).toBe("accounts:7");
    expect(k.ref("accounts", null)).toBeNull();
    expect(() => k.ref("inv_instruments", ACC)).toThrow();
    expect(k.dedupKey(`rule|i:${INS}|a:${ACC}|i:XYZ`)).toBe(
      "rule|i:inv_instruments:3|a:accounts:7|i:XYZ",
    );
    expect(k.ruleId("drawdown")).toBe("drawdown");
  });

  it("reads a dangling key part (a genesis gid of a missing row) as <prefix>:dangling-<id>", () => {
    const k = keysOf();
    const missing = det("genesis", ["alerts", "42"]);
    expect(k.ruleId(`alert:${missing}`)).toBe("alert:alert:dangling-42");
  });
});

const ev = (type: string, gid: string, data: Record<string, unknown>): GenesisEvent => ({
  type,
  gid,
  at: "2026-10-31T12:00:00.001Z",
  data,
});

describe("inverse builders", () => {
  it("shape a cash expense as Python stores it", () => {
    const g = "0a1b2c3d-0000-8000-8000-0000000000aa";
    const [row] = inverseRows(
      cashExpenses,
      [
        ev("txn.cashExpenseAdded", g, {
          account: ACC,
          bookingDate: "2026-09-16",
          amount: "-45.00",
          currency: "PLN",
          title: "Targ Test",
          category: "groceries",
          stamps: { created_at: "2026-10-01T10:00:00.5Z" },
        }),
      ],
      keysOf(),
    );
    expect(row?.row).toMatchObject({
      account_id: "accounts:7",
      counterparty_name: "Targ Test",
      reference: "Targ Test",
      source: "manual",
      occurrence: 0n,
      category_source: "manual_txn",
      raw: { cash_expense: true },
      created_at: "2026-10-01T10:00:00.500000",
    });
    expect(Object.keys(row?.row ?? {}).sort()).toEqual(
      [...(ROUNDTRIP_COLUMNS.transactions ?? [])].sort(),
    );
  });

  it("number strategy versions over applied versions and skip a repeated sha (m9)", () => {
    const save = (gid: string, sha: string) =>
      ev("strategy.versionSaved", gid, {
        yamlText: "y",
        mdText: null,
        sha256: sha,
        state: "ok",
        issues: [],
      });
    const rows = inverseRows(
      JOURNAL_INVERSE.inv_strategy_versions as never,
      [save("A".repeat(26), "s1"), save("B".repeat(26), "s1"), save("C".repeat(26), "s2")],
      keysOf(),
    );
    expect(rows.map((r) => [r.row.version, r.row.sha256])).toEqual([
      [1n, "s1"],
      [2n, "s2"],
    ]);
  });
});

describe("modes", () => {
  it("cover every synced table; pending entries belong to view-mode tables", () => {
    expect(STORE_TABLES.length).toBe(33);
    expect(STORE_TABLES.filter((t) => modeOf(t) === "view").sort()).toEqual(
      [...VIEW_TABLES].sort(),
    );
    for (const t of [...Object.keys(PENDING_ROWS), ...Object.keys(PENDING_COLUMNS)]) {
      expect(VIEW_TABLES.has(t), t).toBe(true);
    }
  });
});
