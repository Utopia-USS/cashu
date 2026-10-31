/// <reference types="node" />
// S26 spec 4.2 (budget v2 + v1 mismatch, cash legs), 4.5 (inv occurrence recovery: match, rank
// fallback, reconciliation; instrumentKey 7.2), 6.3 (collisions). The Python fixture
// testing/invHashParity.json (synthetic files through the real import service) pins recovery and
// the 7.2 keys against Python's reference. Synthetic rows only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { D, investments } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import type { SqlDriver } from "../sql/driver.js";
import { budgetTxnKind, cashLegSource } from "./hashes.js";
import { GenesisError } from "./report.js";
import type { TransactionRow } from "./rows.js";
import { gidOf, phase1 } from "./testing/phase1.js";
import { PythonRows } from "./testing/pythonRows.js";
import { pythonDb } from "./testing/pythonSchema.js";

const hex = (algo: "sha1" | "sha256", text: string) =>
  createHash(algo).update(text, "utf8").digest("hex");

function db() {
  const driver = pythonDb("0028");
  const rows = new PythonRows(driver);
  rows.insert("profiles", {});
  return { driver, rows };
}

describe("budget transactions", () => {
  it("classifies legs first, then cash expenses, and finds a leg's source", () => {
    const row = (dedupHash: string, raw: unknown = null) =>
      ({ dedupHash, raw }) as unknown as TransactionRow;
    expect(budgetTxnKind(row("cashleg:12"))).toBe("cashLeg");
    expect(budgetTxnKind(row("cashexp:abc", { cash_leg_of: 3 }))).toBe("cashLeg");
    expect(budgetTxnKind(row("cashexp:abc", { cash_leg_of: null }))).toBe("cashExpense");
    expect(budgetTxnKind(row("f".repeat(40), { other: 1 }))).toBe("bank");
    expect(cashLegSource(row("cashleg:12"))).toBe(12);
    expect(cashLegSource(row("cashleg:12", { cash_leg_of: "34" }))).toBe(34);
    expect(cashLegSource(row("cashleg:x"))).toBeUndefined();
  });

  it("hashes v2 from the stored columns and counts stored hashes v1 does not reproduce", () => {
    const { driver, rows } = db();
    rows.insert("accounts", {});
    const base = {
      booking_date: "2026-03-01",
      amount: "-5.5",
      currency: "pln",
      counterparty_iban: "PL 38 1234 0000 0000 0000 0000 0001",
      counterparty_name: "Ignored when the IBAN is set",
      description: "Opłata",
      reference: "ref 1",
    };
    const key = "2026-03-01|-5.50|PLN|38123400000000000000000001|OPLATA REF 1";
    const good = rows.insert("transactions", { ...base, dedup_hash: hex("sha1", `1|${key}`) });
    rows.insert("transactions", { ...base, dedup_hash: "0".repeat(40), occurrence: 1 });
    const { vaults, counters } = phase1(driver);
    expect(vaults[0]?.budgetTxns.get(good)).toEqual({ dedupHash: hex("sha1", key), occurrence: 0 });
    expect(counters.get("transactions", "budget_v1_mismatch", 0)).toBe(1);
  });

  it("gives a colliding row the smallest free occurrence above its own", () => {
    const { driver, rows } = db();
    rows.insert("accounts", {});
    const same = { booking_date: "2026-03-02", amount: "1.00", description: "x" };
    const a = rows.insert("transactions", { ...same, dedup_hash: "1".repeat(40), occurrence: 0 });
    const b = rows.insert("transactions", { ...same, dedup_hash: "2".repeat(40), occurrence: 0 });
    const c = rows.insert("transactions", { ...same, dedup_hash: "3".repeat(40), occurrence: 1 });
    const { vaults, counters } = phase1(driver);
    const occ = (id: number) => vaults[0]?.budgetTxns.get(id)?.occurrence;
    expect([occ(a), occ(b), occ(c)]).toEqual([0, 2, 1]);
    expect(counters.get("transactions", "budget_v2_collision", 0)).toBe(1);
    expect(new Set([a, b, c].map((id) => gidOf(vaults[0], "transactions", id))).size).toBe(3);
  });
});

// ---- investments ----------------------------------------------------------------------------

interface StoredV1 {
  readonly txnId: number;
  readonly kind: "ref" | "content" | "reconciliation";
  readonly brokerId: string | null;
  readonly occurrence: number | null;
  readonly ikeyGenesis: string;
}

interface Fixture {
  readonly stored: {
    readonly tables: Readonly<
      Record<string, readonly Readonly<Record<string, string | number | null>>[]>
    >;
  };
  readonly storedV1: readonly StoredV1[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./testing/invHashParity.json", import.meta.url), "utf8"),
) as Fixture;

function loadFixture(driver: SqlDriver): void {
  for (const [table, rows] of Object.entries(fixture.stored.tables)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      driver
        .prepare(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...Object.values(row));
    }
  }
}

type Txn = Readonly<Record<string, string | number | null>>;

/** v2 of a stored row from an explicit instrument key and occurrence (the expected side). */
function v2Of(row: Txn, accountGid: string, instrumentKey: string, broker: string, k: number) {
  const input = investments.dedupInputFromStored(
    {
      tradeDate: String(row.trade_date),
      type: String(row.type),
      currency: String(row.currency),
      grossAmount: D(String(row.gross_amount)),
      cashAmount: D(String(row.cash_amount)),
      externalRef:
        row.external_ref === null || row.external_ref === undefined
          ? null
          : String(row.external_ref),
      quantity: row.quantity === null ? null : D(String(row.quantity)),
      price: row.price === null ? null : D(String(row.price)),
    },
    instrumentKey,
  );
  const parts = investments.hashPartsV2(investments.hashPathOf(input, broker, k), accountGid);
  return hex("sha256", parts.join(investments.US));
}

describe("investment transactions: the Python fixture", () => {
  const driver = pythonDb("0028");
  loadFixture(driver);
  const { vaults, counters } = phase1(driver);
  const v = vaults[0];
  const txns = new Map((fixture.stored.tables.inv_transactions ?? []).map((t) => [t.id, t]));

  it("recovers every stored occurrence (29 v1 matches, 1 reconciliation match)", () => {
    expect(counters.get("inv_transactions", "occ_v1_match", 0)).toBe(29);
    expect(counters.get("inv_transactions", "occ_fallback", 0)).toBe(0);
    expect(counters.get("inv_transactions", "recon_match", 0)).toBe(1);
    expect(counters.get("inv_transactions", "recon_mismatch", 0)).toBe(0);
    expect(counters.get("inv_transactions", "inv_v2_collision", 0)).toBe(0);
  });

  it("builds v2 from Python's 7.2 instrument key and recovered occurrence", () => {
    expect(fixture.storedV1.length).toBe(30);
    for (const entry of fixture.storedV1) {
      const row = txns.get(entry.txnId) as Txn;
      const accountGid = gidOf(v, "accounts", Number(row.account_id));
      const ikey = entry.ikeyGenesis.replace(
        /^gid:@(\d+)$/,
        (_, id: string) => `gid:${gidOf(v, "inv_instruments", Number(id))}`,
      );
      const expected =
        entry.kind === "reconciliation"
          ? hex(
              "sha256",
              investments
                .hashPartsV2(
                  {
                    kind: "reconciliation",
                    instrumentKey: ikey,
                    asOf: String(row.trade_date),
                    type: String(row.type),
                    quantity: D(String(row.quantity)),
                  },
                  accountGid,
                )
                .join(investments.US),
            )
          : v2Of(row, accountGid, ikey, entry.brokerId ?? "manual", entry.occurrence ?? -1);
      expect(v?.invDedupHashes.get(entry.txnId), `txn ${entry.txnId}`).toBe(expected);
      expect(gidOf(v, "inv_transactions", entry.txnId)).toBe(
        v?.det("inv_transactions", [accountGid, expected]),
      );
    }
    const steps = ["ikey_broker", "ikey_isin_alias", "ikey_isin_col", "ikey_gid"];
    const instrumentRows = fixture.storedV1.filter(
      (e) => e.kind !== "reconciliation" && e.ikeyGenesis !== "",
    ).length;
    expect(steps.reduce((n, s) => n + counters.get("inv_transactions", s, 0), 0)).toBe(
      instrumentRows,
    );
  });
});

describe("investment transactions: synthetic", () => {
  function setup() {
    const { driver, rows } = db();
    const account = rows.insert("accounts", { external_id: "brokerage:1" });
    const batch = rows.insert("inv_import_batches", { account_id: account, broker: "cashu" });
    return { driver, rows, account, batch };
  }
  const buy = {
    type: "buy",
    trade_date: "2026-04-01",
    quantity: "3",
    price: "10",
    gross_amount: "30",
    cash_amount: "-30",
  };
  const v1 = (account: number, instrument: number | "", k: number) =>
    hex(
      "sha256",
      ["v1", "content", account, "2026-04-01", "buy", instrument, "3", "10", "30", "-30", k].join(
        "\u001f",
      ),
    );

  it("falls back to the rank by (created_at, id) when no k reproduces the stored hash", () => {
    const { driver, rows, account, batch } = setup();
    const common = { ...buy, account_id: account, import_batch_id: batch };
    const late = rows.insert("inv_transactions", {
      ...common,
      dedup_hash: "a".repeat(64),
      created_at: "2026-04-02 10:00:00.5",
    });
    const early = rows.insert("inv_transactions", {
      ...common,
      dedup_hash: "b".repeat(64),
      created_at: "2026-04-02 10:00:00",
    });
    const { vaults, counters } = phase1(driver);
    const v = vaults[0];
    const accountGid = gidOf(v, "accounts", account);
    expect(counters.get("inv_transactions", "occ_fallback", 0)).toBe(2);
    expect(v?.invDedupHashes.get(early)).toBe(v2Of(buy, accountGid, "", "cashu", 0));
    expect(v?.invDedupHashes.get(late)).toBe(v2Of(buy, accountGid, "", "cashu", 1));
  });

  // legacy name: the pre-rename broker namespace is equivalent
  it("walks the 7.2 steps and the cashu / finanse namespace equivalence", () => {
    const { driver, rows, account, batch } = setup();
    const inst = (isin: string | null = null) => rows.insert("inv_instruments", { isin });
    const [broker, isinAlias, isinCol, bare] = [inst(), inst(), inst("XX0000000009"), inst()];
    rows.insert("inv_instrument_aliases", {
      instrument_id: broker,
      // legacy name
      namespace: "finanse",
      value: "OLD",
    });
    rows.insert("inv_instrument_aliases", {
      instrument_id: broker,
      namespace: "cashu",
      value: "NEW",
    });
    rows.insert("inv_instrument_aliases", {
      instrument_id: isinAlias,
      namespace: "xtb",
      value: "Q",
    });
    rows.insert("inv_instrument_aliases", {
      instrument_id: isinAlias,
      namespace: "isin",
      value: "XX0000000008",
    });
    const ids = [broker, isinAlias, isinCol, bare].map((i) =>
      rows.insert("inv_transactions", {
        ...buy,
        account_id: account,
        import_batch_id: batch,
        instrument_id: i,
        dedup_hash: v1(account, i, 0),
      }),
    );
    const cash = rows.insert("inv_transactions", {
      ...buy,
      account_id: account,
      import_batch_id: batch,
      dedup_hash: v1(account, "", 0),
    });
    const { vaults, counters } = phase1(driver);
    const v = vaults[0];
    const accountGid = gidOf(v, "accounts", account);
    const keys = [
      "cashu:OLD",
      "isin:XX0000000008",
      "isin:XX0000000009",
      `gid:${gidOf(v, "inv_instruments", bare)}`,
    ];
    ids.forEach((id, i) => {
      expect(v?.invDedupHashes.get(id)).toBe(v2Of(buy, accountGid, keys[i] ?? "", "cashu", 0));
    });
    expect(v?.invDedupHashes.get(cash)).toBe(v2Of(buy, accountGid, "", "cashu", 0));
    for (const step of [
      "ikey_broker",
      "ikey_isin_alias",
      "ikey_isin_col",
      "ikey_gid",
      "ikey_ambiguous",
    ]) {
      expect(counters.get("inv_transactions", step, 0), step).toBe(1);
    }
    expect(counters.get("inv_transactions", "occ_v1_match", 0)).toBe(5);
  });

  it("moves a v2 collision to the next free occurrence and keeps manual rows on their gid", () => {
    const { driver, rows, account, batch } = setup();
    const a = rows.insert("inv_instruments", { isin: "XX0000000007" });
    const b = rows.insert("inv_instruments", { isin: "XX0000000007" });
    const first = rows.insert("inv_transactions", {
      ...buy,
      account_id: account,
      import_batch_id: batch,
      instrument_id: a,
      dedup_hash: v1(account, a, 0),
    });
    const second = rows.insert("inv_transactions", {
      ...buy,
      account_id: account,
      import_batch_id: batch,
      instrument_id: b,
      dedup_hash: v1(account, b, 0),
    });
    const manual = rows.insert("inv_transactions", {
      ...buy,
      account_id: account,
      source: "manual",
      dedup_hash: "c".repeat(64),
    });
    const { vaults, counters } = phase1(driver);
    const v = vaults[0];
    const accountGid = gidOf(v, "accounts", account);
    expect(v?.invDedupHashes.get(first)).toBe(
      v2Of(buy, accountGid, "isin:XX0000000007", "cashu", 0),
    );
    expect(v?.invDedupHashes.get(second)).toBe(
      v2Of(buy, accountGid, "isin:XX0000000007", "cashu", 1),
    );
    expect(counters.get("inv_transactions", "inv_v2_collision", 0)).toBe(1);
    const manualGid = v?.det("genesis", ["inv_transactions", String(manual)]);
    expect(gidOf(v, "inv_transactions", manual)).toBe(manualGid);
    expect(v?.invDedupHashes.get(manual)).toBe(`manual:${manualGid}`);
  });

  it("fails the run on a reconciliation collision and counts a reconciliation mismatch", () => {
    const { driver, rows, account } = setup();
    const i = rows.insert("inv_instruments", {});
    const recon = {
      account_id: account,
      instrument_id: i,
      source: "reconciliation",
      type: "adjustment",
      quantity: "2",
    };
    rows.insert("inv_transactions", { ...recon, dedup_hash: "d".repeat(64) });
    rows.insert("inv_transactions", { ...recon, dedup_hash: "e".repeat(64) });
    let error: unknown;
    try {
      phase1(driver);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GenesisError);
    expect((error as GenesisError).code).toBe("recon_collision");
  });
});
