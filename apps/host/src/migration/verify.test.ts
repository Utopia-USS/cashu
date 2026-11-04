import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, vaultSalt } from "@cashu/store";
import type * as genesis from "@cashu/store/genesis";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationError } from "./contract.js";
import { convertStrictGenesis } from "./convert.js";
import { verifyStrictCoreReplay } from "./verify.js";

const roots: string[] = [];
const timestamp = "2026-01-02 03:04:05.000000";
function fixture(): { root: string; keys: ReadonlyMap<string, genesis.VaultKeys> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-migration-verify-")));
  roots.push(root);
  const path = join(root, "cashu.db");
  const db = new DatabaseSync(path);
  try {
    const ddl = readFileSync(
      new URL(
        "../../../../packages/store/src/genesis/testing/python-schema/0025.sql",
        import.meta.url,
      ),
      "utf8",
    );
    db.exec(ddl);
    db.prepare("INSERT INTO alembic_version(version_num) VALUES (?)").run(
      "0025_topic_view_sources",
    );
    for (const [id, slug] of [
      [1, "alpha"],
      [2, "beta"],
    ] as const) {
      db.prepare(
        "INSERT INTO profiles(id,slug,name,base_currency,mcp_privacy,created_at) VALUES (?,?,?,?,?,?)",
      ).run(id, slug, `Synthetic ${slug}`, "PLN", "strict", timestamp);
      db.prepare(
        "INSERT INTO profile_modules(profile_id,module_id,enabled,enabled_at) VALUES (?,?,?,?)",
      ).run(id, "budget", 1, timestamp);
      db.prepare(
        "INSERT INTO accounts(id,profile_id,bank,name,currency,type,active,created_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(id * 10, id, "synthetic", `Account ${id}`, "PLN", "checking", 1, timestamp);
      db.prepare(
        "INSERT INTO balances(id,account_id,date,amount,currency,source,created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(id * 100, id * 10, "2026-01-02", `${id}.00`, "PLN", "CSV", timestamp);
    }
  } finally {
    db.close();
  }
  chmodSync(path, 0o600);
  const keys = new Map<string, genesis.VaultKeys>([
    ["alpha", { vault: "a".repeat(32), salt: vaultSalt(Buffer.alloc(32, 1)) }],
    ["beta", { vault: "b".repeat(32), salt: vaultSalt(Buffer.alloc(32, 2)) }],
  ]);
  return { root, keys };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("strict native genesis and independent core replay", () => {
  it("compares two profile source fields with independently replayed fields", () => {
    const { root, keys } = fixture();
    const conversion = convertStrictGenesis(root, keys, Date.parse("2027-01-01T00:00:00Z"));
    const proof = verifyStrictCoreReplay(conversion, keys);
    expect(proof).toMatchObject({ profiles: 2, tables: 66, rows: 8 });
    expect(proof.vaults).toHaveLength(2);
    expect(proof.vaults[0]?.semanticHash).not.toBe(proof.vaults[1]?.semanticHash);
  });

  it("accounts for offline FX cache rows in independent source verification", () => {
    const { root, keys } = fixture();
    const db = new DatabaseSync(join(root, "cashu.db"));
    try {
      db.prepare(
        "INSERT INTO inv_fx_rates(id,base,quote,date,rate,source) VALUES (?,?,?,?,?,?)",
      ).run(1, "EUR", "USD", "2026-01-02", "1.07", "synthetic");
    } finally {
      db.close();
    }
    const conversion = convertStrictGenesis(root, keys, Date.parse("2027-01-01T00:00:00Z"));
    expect(verifyStrictCoreReplay(conversion, keys).sourceCache.fxRates).toBe(1);
  });

  it("refuses equal-count altered log content even with its claimed hash recomputed", () => {
    const { root, keys } = fixture();
    const conversion = convertStrictGenesis(root, keys, Date.parse("2027-01-01T00:00:00Z"));
    const first = conversion.genesis.vaults[0];
    if (!first) throw new Error("synthetic fixture has no first profile");
    const lines = [...first.lines];
    const index = lines.findIndex((line) => JSON.parse(line).t === "profile.created");
    if (index < 0) throw new Error("synthetic fixture has no profile event");
    const event = JSON.parse(lines[index] ?? "{}") as Record<string, unknown>;
    const data = event.d as Record<string, unknown>;
    lines[index] =
      `${canonicalJson({ ...event, d: { ...data, name: "Altered synthetic name" } })}\n`;
    const mutated = {
      ...first,
      lines,
      logSha256: createHash("sha256").update(lines.join("")).digest("hex"),
    };
    const altered = {
      ...conversion,
      genesis: { ...conversion.genesis, vaults: [mutated, ...conversion.genesis.vaults.slice(1)] },
    };
    expect(() => verifyStrictCoreReplay(altered, keys)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
  });

  it("refuses a changed gid map for an otherwise unreferenced module row", () => {
    const { root, keys } = fixture();
    const conversion = convertStrictGenesis(root, keys, Date.parse("2027-01-01T00:00:00Z"));
    const first = conversion.genesis.vaults[0];
    if (!first) throw new Error("synthetic fixture has no first profile");
    const entry = first.ids.find((item) => item.table === "profile_modules");
    if (!entry) throw new Error("synthetic fixture has no module mapping");
    const alteredVault = {
      ...first,
      ids: first.ids.map((item) => (item === entry ? { ...item, gid: "f".repeat(32) } : item)),
    };
    const altered = {
      ...conversion,
      genesis: {
        ...conversion.genesis,
        vaults: [alteredVault, ...conversion.genesis.vaults.slice(1)],
      },
    };
    expect(() => verifyStrictCoreReplay(altered, keys)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
  });

  it("refuses a whole omitted profile even when its vault and report are removed together", () => {
    const { root, keys } = fixture();
    const conversion = convertStrictGenesis(root, keys, Date.parse("2027-01-01T00:00:00Z"));
    const first = conversion.genesis.vaults[0];
    const firstReport = conversion.genesis.report.vaults[0];
    if (!first || !firstReport) throw new Error("synthetic fixture has no first profile");
    const altered = {
      ...conversion,
      genesis: {
        ...conversion.genesis,
        vaults: [first],
        report: {
          ...conversion.genesis.report,
          vaults: [firstReport],
          counters: {
            ...conversion.genesis.report.counters,
            vaults: { 0: conversion.genesis.report.counters.vaults[0] ?? {} },
          },
        },
      },
    };
    expect(() => verifyStrictCoreReplay(altered, keys)).toThrowError(
      new MigrationError("replay_mismatch"),
    );
  });
});
