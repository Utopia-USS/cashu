import { describe, expect, it } from "vitest";
import { seededDb } from "../testing/genesisData.js";
import { PythonRows } from "../testing/pythonRows.js";
import { sourceDerivedTransactions } from "./sourceDerived.js";

describe("frozen source derived budget state", () => {
  it("matches transfers by own counterparty IBAN only and stays within one profile", () => {
    const db = seededDb("0029");
    try {
      const rows = new PythonRows(db);
      const receiving = rows.insert("accounts", {
        profile_id: 1,
        iban: "PL00111122223333444455556666",
        external_id: "synthetic:receiving",
      });
      const out = rows.insert("transactions", {
        account_id: 1,
        amount: "-42.00",
        counterparty_iban: "PL00111122223333444455556666",
        dedup_hash: "a".repeat(40),
      });
      const incoming = rows.insert("transactions", {
        account_id: receiving,
        amount: "42.00",
        dedup_hash: "b".repeat(40),
      });
      const nameOnlyOut = rows.insert("transactions", {
        account_id: 1,
        amount: "-99.00",
        counterparty_name: "Synthetic Same Name",
        dedup_hash: "c".repeat(40),
      });
      const nameOnlyIn = rows.insert("transactions", {
        account_id: receiving,
        amount: "99.00",
        counterparty_name: "Synthetic Same Name",
        dedup_hash: "d".repeat(40),
      });
      const otherProfile = rows.insert("transactions", {
        account_id: 7,
        amount: "42.00",
        counterparty_iban: "PL61109010140000071219812874",
        dedup_hash: "e".repeat(40),
      });
      const derived = sourceDerivedTransactions(db, 1);
      expect(derived.get(out)).toMatchObject({ isInternalTransfer: true, transferOutId: out });
      expect(derived.get(incoming)).toMatchObject({ isInternalTransfer: true, transferOutId: out });
      expect(derived.get(nameOnlyOut)?.isInternalTransfer).toBe(false);
      expect(derived.get(nameOnlyIn)?.isInternalTransfer).toBe(false);
      expect(derived.has(otherProfile)).toBe(false);
    } finally {
      db.close();
    }
  });
});
