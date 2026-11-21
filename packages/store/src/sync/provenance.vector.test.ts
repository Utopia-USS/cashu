// Pins the persisted format of the key provenance store (table names, DDL, binding digest, row
// encoding). The vectors were recorded from the host's node:crypto store before it moved here; vaults
// provisioned before the move must open byte-for-byte as before. The host runs the same vectors over
// node:sqlite (apps/host/src/sync/keys/provenance.vector.test.ts). Synthetic data only.
import { createHash } from "node:crypto";
import { crypto } from "@cashu/sync";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import { SqlProvenanceStore } from "./provenance.js";

const VAULT = "0123456789abcdef0123456789abcdef";
const SENDER = "fedcba9876543210fedcba9876543210";
const PEER = "00112233445566778899aabbccddeeff";
const KID = "a".repeat(32);
const SALT = Uint8Array.from({ length: 32 }, (_, index) => index);
const BINDING = `${VAULT}:630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd`;
const META_DDL = `CREATE TABLE vault_key_provenance_meta (
          format INTEGER NOT NULL, binding TEXT NOT NULL
        )`;
const ROWS_DDL = `CREATE TABLE vault_key_provenance (
          kid TEXT PRIMARY KEY NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL,
          sender TEXT NOT NULL, recipients TEXT, source TEXT NOT NULL, received_at INTEGER NOT NULL
        ) WITHOUT ROWID`;

function memory() {
  return betterSqlite3Driver(new Database(":memory:"));
}

/** The three members the provenance store reads from a ring, over a fixed gid salt. */
function fixedRing(): crypto.Keyring {
  return {
    vaultId: VAULT,
    gidSalt: () => ({ expose: () => SALT.slice(), wipe: () => {} }),
    entries: () => [{ kid: KID, generation: 1, epoch: 0 }],
  } as unknown as crypto.Keyring;
}

describe("key provenance persisted format", () => {
  it("writes the pinned DDL, binding digest and row encoding", () => {
    const driver = memory();
    const store = SqlProvenanceStore.open(driver, fixedRing(), "new");
    store.put({
      kid: KID,
      generation: 1,
      epoch: 0,
      sender: SENDER,
      recipients: [SENDER, PEER],
      source: "wrap",
      receivedAt: 1_700_000_000_000,
    });
    expect(
      driver
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all(),
    ).toEqual([
      { name: "vault_key_provenance", sql: ROWS_DDL },
      { name: "vault_key_provenance_meta", sql: META_DDL },
    ]);
    expect(driver.prepare("SELECT format, binding FROM vault_key_provenance_meta").all()).toEqual([
      { format: 1, binding: BINDING },
    ]);
    expect(driver.prepare("SELECT * FROM vault_key_provenance").all()).toEqual([
      {
        kid: KID,
        generation: 1,
        epoch: 0,
        sender: SENDER,
        recipients: `["${SENDER}","${PEER}"]`,
        source: "wrap",
        received_at: 1_700_000_000_000,
      },
    ]);
    expect(SqlProvenanceStore.open(driver, fixedRing(), "existing").list()).toHaveLength(1);
    driver.close();
  });

  it("opens a store written in the pinned format by hand", () => {
    const driver = memory();
    driver.exec(`${META_DDL};\n${ROWS_DDL};`);
    driver.prepare("INSERT INTO vault_key_provenance_meta VALUES (1, ?)").run(BINDING);
    driver
      .prepare("INSERT INTO vault_key_provenance VALUES (?, 1, 0, ?, NULL, 'own', 5)")
      .run(KID, SENDER);
    const store = SqlProvenanceStore.open(driver, fixedRing(), "existing");
    expect(store.get(KID)).toEqual({
      kid: KID,
      generation: 1,
      epoch: 0,
      sender: SENDER,
      recipients: null,
      source: "own",
      receivedAt: 5,
    });
    expect(() => store.assertRing(fixedRing())).not.toThrow();
    driver.close();
  });

  it("binds a real ring by the sha256 of its gid salt", async () => {
    const sodium = await crypto.loadNodeSodium();
    const identity = crypto.createDeviceIdentity(sodium);
    const recovery = crypto.recoveryIdentity(sodium, crypto.createRecoveryKey(sodium).phrase);
    const { ring } = crypto.createVaultWithRecovery(sodium, recovery, identity);
    const salt = ring.gidSalt();
    const expected = `${ring.vaultId}:${createHash("sha256").update(salt.expose()).digest("hex")}`;
    salt.wipe();
    const driver = memory();
    SqlProvenanceStore.open(driver, ring, "new");
    expect(driver.prepare("SELECT binding FROM vault_key_provenance_meta").get()).toEqual({
      binding: expected,
    });
    driver.close();
    ring.wipe();
    identity.wipe();
  });
});
