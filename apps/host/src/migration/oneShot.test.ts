import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireHostLock, hostRunPaths } from "@cashu/node-host";
import type { createProductionKeyStore } from "@cashu/node-host/keyring";
import { createTestKeyStore } from "@cashu/node-host/testing";
import { prepareCommand, renameProfile, toUnstampedEvent } from "@cashu/store";
import { expect, it } from "vitest";
import { takeWriterLease } from "../lease.js";
import { openNativeVault } from "../nativeVault.js";
import { ProductionVaultSourceFactory } from "../productionVaultSource.js";
import { assertRecoveryFileDestination } from "./cli.js";
import { importPythonDataDir, verifyPythonMigration } from "./oneShot.js";

it("imports an offline synthetic Python directory into fresh encrypted vaults and re-verifies", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "t44-test-")));
  const sourceDir = join(base, "source");
  const targetDir = join(base, "data");
  mkdirSync(sourceDir, { mode: 0o700 });
  const dbPath = join(sourceDir, "cashu.db");
  const db = new DatabaseSync(dbPath);
  const timestamp = "2026-01-02 03:04:05.000000";
  const stagedBytes = new TextEncoder().encode("synthetic import bytes\n");
  const stagedSha = createHash("sha256").update(stagedBytes).digest("hex");
  const stagedPath = `imports/synthetic/.proposals/${stagedSha}-0123456789ab.csv`;
  try {
    db.exec(
      readFileSync(
        new URL(
          "../../../../packages/store/src/genesis/testing/python-schema/0025.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    db.prepare("INSERT INTO alembic_version(version_num) VALUES (?)").run(
      "0025_topic_view_sources",
    );
    db.prepare(
      "INSERT INTO profiles(id,slug,name,base_currency,mcp_privacy,created_at) VALUES (?,?,?,?,?,?)",
    ).run(1, "synthetic", "Synthetic", "PLN", "strict", timestamp);
    db.prepare(
      "INSERT INTO accounts(id,bank,name,currency,type,active,created_at,profile_id) VALUES (?,?,?,?,?,?,?,?)",
    ).run(1, "manual", "Synthetic account", "PLN", "checking", 1, timestamp, 1);
    db.prepare(
      "INSERT INTO proposals(id,profile_id,kind,status,summary,payload,result,source,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      1,
      1,
      "import",
      "pending",
      "Synthetic staged import",
      JSON.stringify({ account_id: 1, staged: stagedPath }),
      "{}",
      "user",
      timestamp,
    );
    db.prepare(
      "INSERT INTO inv_fx_rates(id,base,quote,date,rate,source,fetched_at) VALUES (?,?,?,?,?,?,?)",
    ).run(1, "EUR", "USD", "2026-01-02", "1.07", "nbp", null);
    db.prepare(
      "INSERT INTO inv_macro_bars(id,series,date,close,source,fetched_at) VALUES (?,?,?,?,?,?)",
    ).run(1, "growth", "2026-01-02", "101.2", "manual", null);
  } finally {
    db.close();
  }
  mkdirSync(join(sourceDir, "imports", "synthetic", ".proposals"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(join(sourceDir, stagedPath), stagedBytes, { mode: 0o600 });
  chmodSync(dbPath, 0o600);
  const before = readFileSync(dbPath);
  const osItems = new Map<string, Uint8Array>();
  const service = `cashu-next-test.${randomBytes(16).toString("hex")}`;
  const keyring = {
    async get(s: string, account: string) {
      return osItems.get(`${s}/${account}`)?.slice() ?? null;
    },
    async set(s: string, account: string, value: Uint8Array) {
      osItems.set(`${s}/${account}`, value.slice());
    },
  };
  const makeKeyStore: typeof createProductionKeyStore = (input) =>
    createTestKeyStore({ ...input, service, keyring });
  const at = Date.parse("2027-01-01T00:00:00Z");
  let words = "";
  try {
    await expect(
      importPythonDataDir({
        sourceDir,
        targetDir: join(sourceDir, "..native"),
        at,
        makeKeyStore,
        async saveRecoveryWords() {
          throw new Error("must not reach recovery");
        },
      }),
    ).rejects.toThrow("source_unsafe");
    const alias = join(base, "source-alias");
    symlinkSync(sourceDir, alias);
    expect(() =>
      assertRecoveryFileDestination(join(sourceDir, "words.txt"), alias, targetDir),
    ).toThrow("recovery file must be outside source and target");
    const imported = await importPythonDataDir({
      sourceDir,
      targetDir,
      at,
      makeKeyStore,
      async saveRecoveryWords(value) {
        words = value;
      },
    });
    expect(words.split(" ")).toHaveLength(24);
    expect(imported.profiles).toBe(1);
    expect(imported.vaults).toHaveLength(1);
    const firstVault = imported.vaults.at(0);
    if (!firstVault) throw new Error("synthetic vault missing");
    const blobPath = join(targetDir, "vaults", firstVault.vaultId, "blobs", `${stagedSha}.csv.enc`);
    expect(readFileSync(blobPath)).not.toEqual(stagedBytes);
    const verified = await verifyPythonMigration({ sourceDir, targetDir, at, makeKeyStore });
    expect(verified).toEqual(imported);
    expect(readFileSync(dbPath)).toEqual(before);
    let secondWords = false;
    await expect(
      importPythonDataDir({
        sourceDir,
        targetDir,
        at,
        makeKeyStore,
        async saveRecoveryWords() {
          secondWords = true;
        },
      }),
    ).rejects.toThrow("identity_invalid");
    expect(secondWords).toBe(false);
    const local = new DatabaseSync(join(targetDir, "stores", "device.db"));
    try {
      local.prepare("UPDATE local_market_macro_bars SET close=? WHERE id=1").run("999");
    } finally {
      local.close();
    }
    await expect(verifyPythonMigration({ sourceDir, targetDir, at, makeKeyStore })).rejects.toThrow(
      "replay_mismatch",
    );
    const factory = new ProductionVaultSourceFactory(targetDir, makeKeyStore);
    factory.preflight();
    const lock = acquireHostLock(hostRunPaths(targetDir).lockPath);
    if (!lock) throw new Error("synthetic host lock unavailable");
    try {
      const source = await factory.open(lock);
      const entry = source.inventory.at(0);
      if (!entry) throw new Error("synthetic inventory missing");
      const first = await openNativeVault(
        entry,
        targetDir,
        source,
        takeWriterLease(lock),
        () => at,
      );
      try {
        await first.queue.run(async () => {
          const prepared = prepareCommand(
            first.store,
            renameProfile,
            { name: "Synthetic after import" },
            {
              device: first.device,
              clock: { now: () => at + 1 },
              lease: { isHolder: () => first.isCurrent() },
            },
          );
          if (!prepared.ok) throw new Error(prepared.reason);
          await first.engine.write(prepared.events.map(toUnstampedEvent));
        });
      } finally {
        await first.close();
      }
      const restarted = await openNativeVault(
        entry,
        targetDir,
        source,
        takeWriterLease(lock),
        () => at + 2,
      );
      try {
        expect(restarted.store.read<{ name: string }>("SELECT name FROM profiles")).toEqual([
          { name: "Synthetic after import" },
        ]);
      } finally {
        await restarted.close();
      }
    } finally {
      lock.release();
    }
    expect(readFileSync(dbPath)).toEqual(before);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
