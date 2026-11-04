import type { GenesisResult } from "@cashu/store/genesis";
import type { SourceCounterEvidence } from "@cashu/store/genesis/verification";
import { describe, expect, it } from "vitest";
import { accountGenesis } from "./accounting.js";
import { MigrationError } from "./contract.js";

function fixture(reason?: string): GenesisResult {
  return {
    schema: "0030_sync_outbox_post",
    report: {
      schema: "0030_sync_outbox_post",
      fk: {},
      counters: {
        global: {},
        vaults: reason ? { "0": { side_files: { [reason]: 1 } } } : {},
      },
      vaults: [{ ordinal: 0, events: 1, byType: { "profile.created": 1 }, fk: {}, files: {} }],
    },
    vaults: [
      {
        ordinal: 0,
        profileId: 1,
        slug: "synthetic",
        vault: "a".repeat(32),
        device: "synthetic-device",
        wall: 0,
        events: [{ t: "profile.created" }],
        lines: ["synthetic-line"],
        logSha256: "b".repeat(64),
        ids: [{ table: "profiles", localId: "1", gid: "synthetic-gid" }],
        deviceLocal: { notifications: [], connectorFetch: [] },
      },
    ],
  } as unknown as GenesisResult;
}

describe("migration genesis accounting", () => {
  it("accepts a fully accounted synthetic result", () => {
    expect(accountGenesis(fixture())).toMatchObject({ profiles: 1, events: 1, ids: 1 });
  });
  it.each([
    "budget_json_invalid",
    "strategy_files_differ",
    "archive_missing",
    "json_float",
    "unscoped",
  ])("refuses %s even when ordinary strict genesis could return", (reason) =>
    expect(() => accountGenesis(fixture(reason))).toThrowError(
      new MigrationError("semantic_difference"),
    ),
  );
  it("refuses consecutive same-sha strategy versions until replay proves both versions", () => {
    expect(() => accountGenesis(fixture("strategy_same_sha"))).toThrowError(
      new MigrationError("semantic_difference"),
    );
  });
  it("refuses duplicate mapping identity", () => {
    const result = fixture();
    const duplicate = { ...result, vaults: [...result.vaults, result.vaults[0]] } as GenesisResult;
    expect(() => accountGenesis(duplicate)).toThrowError(new MigrationError("mapping_invalid"));
  });
  it("accepts only source-audited successful normalization counts", () => {
    const base = fixture();
    const result = {
      ...base,
      report: {
        ...base.report,
        counters: {
          global: { reviews: { json_float: 2 } },
          vaults: {
            "0": {
              accounts: { iban_invalid: 1 },
              inv_instruments: { instrument_orphan: 3 },
            },
          },
        },
      },
    } as GenesisResult;
    const evidence: SourceCounterEvidence = {
      format: 1,
      jsonFloat: { reviews: 2 },
      vaults: [
        {
          ordinal: 0,
          ibanInvalid: 1,
          instrumentOrphan: 3,
          danglingWatchlistDetails: 0,
          investment: {},
        },
      ],
    };
    expect(accountGenesis(result, evidence).profiles).toBe(1);
    expect(() => accountGenesis(result, { ...evidence, jsonFloat: { reviews: 1 } })).toThrowError(
      new MigrationError("semantic_difference"),
    );
    const other = {
      ...result,
      report: {
        ...result.report,
        counters: {
          ...result.report.counters,
          vaults: {
            "0": {
              ...result.report.counters.vaults["0"],
              inv_transactions: { ikey_broker: 1 },
            },
          },
        },
      },
    } as GenesisResult;
    expect(() => accountGenesis(other, evidence)).toThrowError(
      new MigrationError("semantic_difference"),
    );
  });
});
