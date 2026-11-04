import { D, investments } from "@cashu/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { detGidFor, vaultSalt } from "../../gid.js";
import type { GenesisResult } from "../index.js";
import { PythonRows } from "../testing/pythonRows.js";
import { pythonDb } from "../testing/pythonSchema.js";
import {
  auditSourceInvHashes,
  SourceInvHashError,
  verifyReplayInvHashes,
  verifySourceInvGids,
} from "./sourceInvHashes.js";

describe("investment source to replay hash equality", () => {
  it("recomputes broker identity and v1 occurrence from frozen source rows", () => {
    const db = pythonDb("0029");
    try {
      const rows = new PythonRows(db);
      rows.insert("profiles", { id: 1, slug: "alpha" });
      rows.insert("accounts", { id: 1, profile_id: 1 });
      rows.insert("inv_instruments", { id: 1, isin: "XX0000000001" });
      rows.insert("inv_instrument_aliases", {
        id: 1,
        instrument_id: 1,
        namespace: "xtb",
        value: "SYNTH",
      });
      rows.insert("inv_import_batches", { id: 1, profile_id: 1, account_id: 1, broker: "xtb" });
      const input = investments.dedupInputFromStored(
        {
          tradeDate: "2026-01-02" as investments.CalendarDate,
          type: "buy",
          currency: "PLN",
          grossAmount: D("20"),
          cashAmount: D("-20"),
          externalRef: "order-1",
          quantity: D("2"),
          price: D("10"),
        },
        "1",
      );
      const v1 = bytesToHex(
        sha256(
          new TextEncoder().encode(
            investments
              .hashPartsV1(investments.hashPathOf(input, "xtb", 0), "1")
              .join(investments.US),
          ),
        ),
      );
      rows.insert("inv_transactions", {
        id: 1,
        account_id: 1,
        instrument_id: 1,
        import_batch_id: 1,
        quantity: "2",
        price: "10",
        gross_amount: "20",
        cash_amount: "-20",
        external_ref: "order-1",
        dedup_hash: v1,
      });
      const result = {
        vaults: [
          {
            ordinal: 0,
            profileId: 1,
            ids: [
              { table: "accounts", localId: "1", gid: "a".repeat(32) },
              { table: "inv_instruments", localId: "1", gid: "b".repeat(32) },
              { table: "inv_transactions", localId: "1", gid: "c".repeat(32) },
            ],
          },
        ],
      } as unknown as GenesisResult;
      const evidence = auditSourceInvHashes(db, result)[0];
      if (!evidence) throw Error("synthetic evidence missing");
      expect(evidence?.counters.ikey_broker).toBe(1);
      expect(evidence?.counters.occ_v1_match).toBe(1);
      expect(evidence?.hashes.get("1")?.hash).toMatch(/^[0-9a-f]{64}$/);
      verifyReplayInvHashes(
        [{ gid: "c".repeat(32), dedupHash: evidence.hashes.get("1")?.hash ?? "" }],
        evidence,
      );
    } finally {
      db.close();
    }
  });

  it("refuses an equal-count replay with altered dedup content or mapped gid", () => {
    const evidence = {
      ordinal: 0,
      counters: {
        ikey_broker: 1,
        ikey_isin_alias: 0,
        ikey_isin_col: 0,
        ikey_gid: 0,
        occ_v1_match: 1,
        recon_match: 0,
      },
      hashes: new Map([
        [
          "11",
          { gid: "a".repeat(32), hash: "b".repeat(64), accountGid: "c".repeat(32), manual: false },
        ],
      ]),
    };
    verifyReplayInvHashes([{ gid: "a".repeat(32), dedupHash: "b".repeat(64) }], evidence);
    expect(() =>
      verifyReplayInvHashes([{ gid: "a".repeat(32), dedupHash: "c".repeat(64) }], evidence),
    ).toThrowError(new SourceInvHashError());
    expect(() =>
      verifyReplayInvHashes([{ gid: "d".repeat(32), dedupHash: "b".repeat(64) }], evidence),
    ).toThrowError(new SourceInvHashError());
  });

  it("rejects a copied hash whose source ID map points to a different deterministic gid", () => {
    const salt = vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => i));
    const det = detGidFor(salt);
    const accountGid = "a".repeat(32);
    const hash = "b".repeat(64);
    const gid = det("inv_transactions", [accountGid, hash]);
    const evidence = {
      ordinal: 0,
      counters: {
        ikey_broker: 1,
        ikey_isin_alias: 0,
        ikey_isin_col: 0,
        ikey_gid: 0,
        occ_v1_match: 1,
        recon_match: 0,
      },
      hashes: new Map([["11", { gid, hash, accountGid, manual: false }]]),
    };
    verifySourceInvGids(evidence, salt);
    expect(() =>
      verifySourceInvGids(
        {
          ...evidence,
          hashes: new Map([["11", { gid: "c".repeat(32), hash, accountGid, manual: false }]]),
        },
        salt,
      ),
    ).toThrowError(new SourceInvHashError());
  });
});
