// Investments import batches (S25 spec 4.3, D-S6). Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { account, Events, rows, ulid } from "./testing/kit.js";

const ACC = "01JE0000000000000000000A01";

describe("inv_import_batches", () => {
  it("appends one row per batch with the archive blob key as archive_path", () => {
    const store = openTestStore();
    const ev = new Events();
    const sha = "b".repeat(64);
    store.applyEnvelopes([account(ev, ACC)]);
    const r = store.applyEnvelopes([
      ev.make("invImport.recorded", ulid(1), {
        account: ACC,
        archive: { sha256: sha, ext: "csv" },
        warnings: [{ message: "pominieto wiersz", row: 3, kind: "skipped" }],
        txnCount: 4,
      }),
      ev.make("invImport.recorded", ulid(2), { account: ACC }),
    ]);
    expect([...r.touchedTables]).toEqual(["inv_import_batches"]);
    const all = rows(store, "inv_import_batches");
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      account_id: ACC,
      importer: "cashu",
      broker: "xtb",
      archive_path: `${sha}.csv`,
      txn_count: 4,
      warnings: [{ message: "pominieto wiersz", row: 3, kind: "skipped" }],
    });
    expect(all[1]?.archive_path).toBeNull();
  });

  it("keeps the first applied event of a gid (a ULID is created once)", () => {
    const store = openTestStore();
    const ev = new Events();
    store.applyEnvelopes([
      ev.make("invImport.recorded", ulid(3), { account: ACC, fileName: "a.csv" }, { wall: 1 }),
      ev.make("invImport.recorded", ulid(3), { account: ACC, fileName: "b.csv" }, { wall: 2 }),
    ]);
    expect(rows(store, "inv_import_batches").map((r) => r.file_name)).toEqual(["a.csv"]);
  });
});
