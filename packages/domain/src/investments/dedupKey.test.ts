/// <reference types="node" />
// The dedup key builders against Python `importing/dedup.py` (vectors from
// parity/python/vectors_inv_dedup.py: the exact message each Python hash covers and its sha256) and
// the gid.md section 8 "inv txn" v2 vector.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { D, type Decimal } from "../decimal.js";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import {
  brokerIdForHash,
  contentKey,
  type DedupInput,
  dedupInputFromParsed,
  dedupInputFromStored,
  fillKey,
  hashPartsV1,
  hashPartsV2,
  hashPathOf,
  hashPathsOfFile,
  occurrenceKey,
  occurrenceKeyOf,
  US,
} from "./dedupKey.js";

const sha256 = (message: string): string =>
  createHash("sha256").update(message, "utf8").digest("hex");

interface VectorRow {
  readonly trade_date: string;
  readonly type: string;
  readonly gross_amount: string;
  readonly cash_amount: string;
  readonly external_ref: string | null;
  readonly instrument_key: string | null;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly currency: string | null;
}

const dec = (text: string | null): Decimal | null => (text === null ? null : D(text));

function parsedFields(row: VectorRow) {
  return {
    tradeDate: row.trade_date,
    type: row.type,
    currency: row.currency ?? "",
    grossAmount: D(row.gross_amount),
    cashAmount: D(row.cash_amount),
    externalRef: row.external_ref,
    quantity: dec(row.quantity),
    price: dec(row.price),
  };
}

const vectors = loadVectors("inv-dedup");
const byKind = (kind: string) => vectors.rows.filter((row) => row[0] === kind);

describe("v1 parts reproduce importing/dedup.py", () => {
  it("dedup_hashes over parsed rows (copy_abs, strip, occurrences, legacy broker)", () => {
    const m = new Mismatches();
    for (const [, accountId, brokerId, rows, messages, hashes] of byKind("file")) {
      const inputs = (rows as VectorRow[]).map((row) =>
        dedupInputFromParsed(parsedFields(row), row.instrument_key ?? ""),
      );
      const paths = hashPathsOfFile(inputs, brokerId as string);
      paths.forEach((path, i) => {
        const message = hashPartsV1(path, accountId as string).join(US);
        m.check(
          `file ${accountId}/${brokerId} row ${i} message`,
          message,
          (messages as string[])[i],
        );
        m.check(
          `file ${accountId}/${brokerId} row ${i} sha256`,
          sha256(message),
          (hashes as string[])[i],
        );
      });
    }
    expectAll(m);
  });

  it("dedup_hash on inputs as given (stored values, no abs)", () => {
    const m = new Mismatches();
    for (const [, row, accountId, brokerId, occurrence, message, hash] of byKind("hash")) {
      const v = row as VectorRow;
      const input: DedupInput = {
        ...dedupInputFromStored(parsedFields(v), v.instrument_key ?? ""),
        currency: v.currency,
      };
      const parts = hashPartsV1(
        hashPathOf(input, brokerId as string, occurrence as number),
        accountId as string,
      );
      m.check(`hash ${message}`, parts.join(US), message);
      m.check(`hash sha ${message}`, sha256(parts.join(US)), hash);
    }
    expectAll(m);
  });

  it("reconciliation_hash", () => {
    const m = new Mismatches();
    for (const [, accountId, instrumentId, asOf, type, quantity, message, hash] of byKind(
      "recon",
    )) {
      const parts = hashPartsV1(
        {
          kind: "reconciliation",
          instrumentKey: instrumentId as string,
          asOf: asOf as string,
          type: type as string,
          quantity: D(quantity as string),
        },
        accountId as string,
      );
      m.check(`recon ${message}`, parts.join(US), message);
      m.check(`recon sha ${message}`, sha256(parts.join(US)), hash);
    }
    expectAll(m);
  });
});

describe("re-import side helpers", () => {
  it("occurrence keys group rows by ref + fill key or by content key", () => {
    const row = dedupInputFromParsed(
      {
        tradeDate: "2026-01-07",
        type: "buy",
        currency: "PLN",
        grossAmount: D("-250.00"),
        cashAmount: D("-250.50"),
        externalRef: "  O-7 ",
        quantity: D("-5.0"),
        price: D("5E+1"),
      },
      "3",
    );
    expect(row.quantity?.toString()).toBe("5.0");
    expect(row.grossAmount.toString()).toBe("250.00");
    expect(row.ref).toBe("O-7");
    expect(fillKey(row)).toBe(["buy", "3", "5", "50", "PLN"].join(US));
    expect(occurrenceKeyOf(row)).toBe(
      occurrenceKey({ kind: "ref", ref: "O-7", fillKey: fillKey(row) }),
    );
    const content = { ...row, ref: null };
    expect(occurrenceKeyOf(content)).toBe(
      occurrenceKey({ kind: "content", contentKey: contentKey(row) }),
    );
    expect(contentKey(row)).toBe(["2026-01-07", "buy", "3", "5", "50", "250", "-250.5"].join(US));
  });

  it("brokerIdForHash renames only the canonical namespace", () => {
    // legacy name: hashes keep the pre-rename broker id
    expect(brokerIdForHash("cashu")).toBe("finanse");
    // legacy name, idempotent
    expect(brokerIdForHash("finanse")).toBe("finanse");
    expect(brokerIdForHash("xtb")).toBe("xtb");
  });
});

describe("v2 parts (gid.md 4.6)", () => {
  it("reproduce the gid.md section 8 inv txn vector", () => {
    const accountGid = "a1bb665d-9bf1-81e3-916c-f49d32db099a"; // gid.md 8 "account by external key"
    const parts = hashPartsV2(
      {
        kind: "content",
        contentKey: contentKey({
          tradeDate: "2026-02-03",
          type: "buy",
          instrumentKey: "testbroker:TST",
          quantity: D("10"),
          price: D("12.5"),
          grossAmount: D("125"),
          cashAmount: D("-125.5"),
        }),
        occurrence: 0,
      },
      accountGid,
    );
    expect(parts.slice(0, 3)).toEqual(["v2", "content", accountGid]);
    expect(sha256(parts.join(US))).toBe(
      "a75921e3e5f26dd7918d9b26f7237fbd4cb84d1ffd71686d37f64e6b2eba912e",
    );
  });

  it("ref path renames the legacy broker like v1", () => {
    const path = { kind: "ref", brokerId: "cashu", ref: "R", fillKey: "f", occurrence: 2 } as const;
    // legacy name in the v2 parts
    expect(hashPartsV2(path, "g")).toEqual(["v2", "ref", "g", "finanse", "R", "f", "2"]);
    // legacy name in the v1 parts
    expect(hashPartsV1(path, "1")).toEqual(["v1", "ref", "1", "finanse", "R", "f", "2"]);
  });
});
