import { describe, expect, it } from "vitest";
import type { GenesisResult } from "../index.js";
import { PythonRows } from "../testing/pythonRows.js";
import { pythonDb } from "../testing/pythonSchema.js";
import { auditSourceSuccessCounters, SourceCounterError } from "./sourceCounters.js";

describe("independent source success-counter evidence", () => {
  it("counts JSON fractions, invalid IBANs and unreferenced catalog rows", () => {
    const source = pythonDb("0029");
    try {
      source
        .prepare(
          "INSERT INTO profiles(id,slug,name,base_currency,mcp_privacy,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(1, "alpha", "Synthetic", "PLN", "strict", "2026-01-02 03:04:05.000000");
      source
        .prepare(
          "INSERT INTO accounts(id,profile_id,bank,name,currency,type,iban,active,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          10,
          1,
          "synthetic",
          "Account",
          "PLN",
          "checking",
          "INVALID",
          1,
          "2026-01-02 03:04:05.000000",
        );
      source
        .prepare("INSERT INTO reviews(id,profile_id,module,done_at,stats) VALUES (?,?,?,?,?)")
        .run(1, 1, "investments", "2026-01-02 03:04:05.000000", '{"x":1.5}');
      const result = {
        vaults: [{ ordinal: 0, profileId: 1, slug: "alpha", ids: [] }],
      } as unknown as GenesisResult;
      const evidence = auditSourceSuccessCounters(source, result);
      expect(evidence.jsonFloat.reviews).toBe(1);
      expect(evidence.vaults[0]).toMatchObject({ ibanInvalid: 1, instrumentOrphan: 0 });
      const rows = new PythonRows(source);
      rows.insert("inv_instruments", { name: "Synthetic" });
      expect(auditSourceSuccessCounters(source, result).vaults[0]?.instrumentOrphan).toBe(1);
      rows.insert("research_notes", { profile_id: 1, details: '{"watchlist_item_id":99}' });
      expect(auditSourceSuccessCounters(source, result).vaults[0]?.danglingWatchlistDetails).toBe(
        1,
      );
      source
        .prepare(
          "INSERT INTO profiles(id,slug,name,base_currency,mcp_privacy,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(2, "other", "Other synthetic", "PLN", "strict", "2026-01-02 03:04:05.000000");
      rows.insert("watchlist_items", { id: 99, profile_id: 2 });
      expect(() => auditSourceSuccessCounters(source, result)).toThrowError(
        new SourceCounterError(),
      );
    } finally {
      source.close();
    }
  });
});
