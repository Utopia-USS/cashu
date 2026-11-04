import { describe, expect, it } from "vitest";
import type { GenesisResult } from "../index.js";
import { pythonDb } from "../testing/pythonSchema.js";
import { assertCompleteSourcePartition, SourcePartitionError } from "./sourcePartition.js";

describe("independent source profile and scoped-row partition", () => {
  it("refuses a dropped whole vault, an extra key and an orphan account", () => {
    const source = pythonDb("0029");
    try {
      for (const [id, slug] of [
        [1, "alpha"],
        [2, "beta"],
      ] as const) {
        source
          .prepare(
            "INSERT INTO profiles(id,slug,name,base_currency,mcp_privacy,created_at) VALUES (?,?,?,?,?,?)",
          )
          .run(id, slug, `Synthetic ${slug}`, "PLN", "strict", "2026-01-02 03:04:05.000000");
        source
          .prepare(
            "INSERT INTO accounts(id,profile_id,bank,name,currency,type,active,created_at) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            id * 10,
            id,
            "synthetic",
            `Account ${id}`,
            "PLN",
            "checking",
            1,
            "2026-01-02 03:04:05.000000",
          );
      }
      const result = {
        vaults: [
          { ordinal: 0, profileId: 1, slug: "alpha" },
          { ordinal: 1, profileId: 2, slug: "beta" },
        ],
      } as unknown as GenesisResult;
      const keySlugs = new Set(["alpha", "beta"]);
      expect(assertCompleteSourcePartition(source, result, keySlugs).profiles).toBe(2);
      expect(() =>
        assertCompleteSourcePartition(source, result, new Set([...keySlugs, "extra"])),
      ).toThrowError(new SourcePartitionError());
      expect(() =>
        assertCompleteSourcePartition(
          source,
          { ...result, vaults: result.vaults.slice(0, 1) },
          keySlugs,
        ),
      ).toThrowError(new SourcePartitionError());
      const first = source
        .prepare("SELECT id FROM accounts ORDER BY id LIMIT 1")
        .get<{ id: number }>();
      if (!first) throw new Error("synthetic fixture account missing");
      source.exec("PRAGMA foreign_keys=OFF");
      source.prepare("UPDATE accounts SET profile_id=999 WHERE id=?").run(first.id);
      expect(() => assertCompleteSourcePartition(source, result, keySlugs)).toThrowError(
        new SourcePartitionError(),
      );
    } finally {
      source.close();
    }
  });

  it("accepts a nullable account reference but refuses a cross-profile account", () => {
    const source = pythonDb("0029");
    try {
      for (const [id, slug] of [
        [1, "alpha"],
        [2, "beta"],
      ] as const) {
        source
          .prepare(
            "INSERT INTO profiles(id,slug,name,base_currency,mcp_privacy,created_at) VALUES (?,?,?,?,?,?)",
          )
          .run(id, slug, `Synthetic ${slug}`, "PLN", "strict", "2026-01-02 03:04:05.000000");
      }
      source
        .prepare(
          "INSERT INTO accounts(id,profile_id,bank,name,currency,type,active,created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          20,
          2,
          "synthetic",
          "Other account",
          "PLN",
          "checking",
          1,
          "2026-01-02 03:04:05.000000",
        );
      source
        .prepare(
          "INSERT INTO import_batches(id,source,account_id,started_at,num_seen,num_inserted,num_duplicates,profile_id) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(1, "csv", null, "2026-01-02 03:04:05.000000", 0, 0, 0, 1);
      const result = {
        vaults: [
          { ordinal: 0, profileId: 1, slug: "alpha" },
          { ordinal: 1, profileId: 2, slug: "beta" },
        ],
      } as unknown as GenesisResult;
      expect(
        assertCompleteSourcePartition(source, result, new Set(["alpha", "beta"])).profiles,
      ).toBe(2);
      source.prepare("UPDATE import_batches SET account_id=20 WHERE id=1").run();
      expect(() =>
        assertCompleteSourcePartition(source, result, new Set(["alpha", "beta"])),
      ).toThrowError(new SourcePartitionError());
    } finally {
      source.close();
    }
  });
});
