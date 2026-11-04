import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StartupFailureError } from "@cashu/host-protocol/startup-failure";
import { acquireHostLock, hostRunPaths } from "@cashu/node-host";
import { legacyDataAdmission } from "@cashu/node-host/admission";
import { afterEach, describe, expect, it } from "vitest";
import { takeWriterLease } from "../lease.js";
import { assertLegacyAdmission, nativeSourceAdmission } from "../nativeSourceAdmission.js";
import { openNativeVault } from "../nativeVault.js";
import { ProductionVaultSourceFactory } from "../productionVaultSource.js";
import { migrateInPlace } from "./inPlace.js";
import { verifyPythonMigration } from "./oneShot.js";
import {
  allFiles,
  PYTHON_NAMES,
  type PythonFixture,
  pythonFixture,
  treeHashes,
} from "./testing/inPlaceFixture.js";

const AT = Date.parse("2027-01-01T00:00:00Z");
const BACKUP = "python-backup-20270101T000000000Z";
const STAGING = ".migration-20270101T000000000Z";
const KEK = "cashu.keystore.kek";
const SLOW = 120_000;

const fixtures: PythonFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});
function fixture(): PythonFixture {
  const f = pythonFixture();
  fixtures.push(f);
  return f;
}

async function run(f: PythonFixture, afterCutoverMove?: (moves: number) => void) {
  const stages: string[] = [];
  let words = "";
  const result = await migrateInPlace({
    dataDir: f.dataDir,
    at: AT,
    keychain: f.keychain,
    onProgress: (stage) => stages.push(stage),
    async saveRecoveryWords(value) {
      words = value;
    },
    ...(afterCutoverMove === undefined ? {} : { afterCutoverMove }),
  });
  return { result, stages, words };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StartupFailureError) return error.failure;
    throw error;
  }
  throw new Error("expected a failure");
}

/** The migrated state: originals intact in the backup, native tree in D, no staging, opens. */
async function expectMigrated(f: PythonFixture, before: Record<string, string>) {
  const d = f.dataDir;
  expect(treeHashes(join(d, BACKUP), PYTHON_NAMES)).toEqual(before);
  const names = readdirSync(d).sort();
  expect(names.filter((name) => name.startsWith(".migration-"))).toEqual([]);
  for (const name of PYTHON_NAMES) expect(names.includes(name)).toBe(name === "logs");
  expect(readdirSync(join(d, "logs"))).toEqual([]);
  // The native shell's own entries stay where they were.
  expect(readFileSync(join(d, "desktop-electron", "Local Storage", "state"), "utf8")).toBe(
    "synthetic",
  );
  expect(existsSync(join(d, "diagnostics"))).toBe(true);
  expect(JSON.parse(readFileSync(join(d, "migration.json"), "utf8"))).toEqual({
    version: 1,
    at: AT,
    backupDir: BACKUP,
    profiles: 1,
    financialTables: expect.any(Number),
    financialRows: expect.any(Number),
    vaults: 1,
  });
  // Detectors: the backup, the marker and the diagnostics are not Python data.
  expect(legacyDataAdmission(d)).toBe("no_legacy_sentinel");
  expect(() =>
    nativeSourceAdmission({
      dataDir: d,
      projectRoot: f.base,
      home: f.base,
      env: {},
      platform: "darwin",
      explicitDataDir: true,
    })(),
  ).not.toThrow();
  // Nothing in the native tree names the staging directory it was imported into.
  const staged = Buffer.from(join(d, STAGING));
  for (const file of allFiles(d, (path) => path === BACKUP || path === "desktop-electron"))
    expect(readFileSync(join(d, file)).includes(staged)).toBe(false);
  // The KEK lives in D's namespace; the tree opens through the ordinary production path.
  expect([...f.items.keys()]).toEqual([`${f.service}/${KEK}`]);
  const factory = new ProductionVaultSourceFactory(d, f.makeKeyStore);
  factory.preflight();
  const lock = acquireHostLock(hostRunPaths(d).lockPath);
  if (!lock) throw new Error("synthetic host lock unavailable");
  try {
    const source = await factory.open(lock);
    const entry = source.inventory.at(0);
    if (!entry) throw new Error("synthetic inventory missing");
    const session = await openNativeVault(entry, d, source, takeWriterLease(lock), () => AT);
    try {
      expect(session.store.read<{ name: string }>("SELECT name FROM profiles")).toEqual([
        { name: "Synthetic" },
      ]);
    } finally {
      await session.close();
    }
  } finally {
    lock.release();
  }
}

describe("migrateInPlace", () => {
  it(
    "imports in place, keeps the originals intact in the backup, opens normally and is a no-op twice",
    async () => {
      const f = fixture();
      const before = treeHashes(f.dataDir, PYTHON_NAMES);
      const { result, stages, words } = await run(f);
      expect(stages).toEqual(["preflight", "copy", "import", "verify", "cutover"]);
      expect(words.split(" ")).toHaveLength(24);
      expect(result.status).toBe("migrated");
      expect(result.marker).toEqual(
        JSON.parse(readFileSync(join(f.dataDir, "migration.json"), "utf8")),
      );
      await expectMigrated(f, before);
      // `migrate verify`'s library path: the backup inside D is the source.
      const verified = await verifyPythonMigration({
        sourceDir: join(f.dataDir, BACKUP),
        targetDir: f.dataDir,
        at: AT,
        makeKeyStore: f.makeKeyStore,
      });
      expect(verified.profiles).toBe(result.marker.profiles);
      expect(verified.financialRows).toBe(result.marker.financialRows);

      const listing = readdirSync(f.dataDir).sort();
      const kek = f.items.get(`${f.service}/${KEK}`);
      const again = await run(f);
      expect(again.result).toEqual({ status: "already_migrated", marker: result.marker });
      expect(again.stages).toEqual(["preflight"]);
      expect(again.words).toBe("");
      expect(readdirSync(f.dataDir).sort()).toEqual(listing);
      expect(f.items.get(`${f.service}/${KEK}`)).toEqual(kek);
    },
    SLOW,
  );

  it(
    "removes an orphan KEK and a failed attempt's staging before it imports",
    async () => {
      const f = fixture();
      const orphan = randomBytes(32);
      f.items.set(`${f.service}/${KEK}`, orphan);
      mkdirSync(join(f.dataDir, ".migration-20260101T000000000Z", "source"), {
        recursive: true,
        mode: 0o700,
      });
      const before = treeHashes(f.dataDir, PYTHON_NAMES);
      expect((await run(f)).result.status).toBe("migrated");
      expect(Buffer.from(f.items.get(`${f.service}/${KEK}`) ?? []).equals(orphan)).toBe(false);
      await expectMigrated(f, before);
    },
    SLOW,
  );

  it.each([1, PYTHON_NAMES.length + 1])(
    "finishes a cutover that crashed after %i moves on the next run",
    async (crashAt) => {
      const f = fixture();
      const before = treeHashes(f.dataDir, PYTHON_NAMES);
      const crashed = await failure(
        run(f, (moves) => {
          if (moves === crashAt) throw new Error("synthetic crash");
        }),
      );
      expect(crashed).toMatchObject({ code: "migration_incomplete", detail: "cutover_failed" });
      expect(existsSync(join(f.dataDir, STAGING, "journal.json"))).toBe(true);
      expect(f.items.has(`${f.service}/${KEK}`)).toBe(true);
      // Every detector reports the unfinished cutover, whatever the root shows meanwhile.
      expect(legacyDataAdmission(f.dataDir)).toBe("migration_incomplete");
      expect(() => assertLegacyAdmission(legacyDataAdmission(f.dataDir))).toThrow(
        expect.objectContaining({
          failure: expect.objectContaining({ code: "migration_incomplete" }),
        }),
      );
      const resumed = await run(f);
      expect(resumed.stages).toEqual(["preflight", "cutover"]);
      expect(resumed.words).toBe("");
      expect(resumed.result.status).toBe("migrated");
      await expectMigrated(f, before);
    },
    SLOW,
  );

  it("refuses without touching anything: no Python data, unknown entries, a running host", async () => {
    const empty = fixture();
    for (const name of readdirSync(empty.dataDir))
      if (name !== "desktop-electron")
        rmSync(join(empty.dataDir, name), { recursive: true, force: true });
    expect(
      await failure(
        migrateInPlace({
          dataDir: empty.dataDir,
          at: AT,
          keychain: empty.keychain,
          saveRecoveryWords: async () => {},
        }),
      ),
    ).toMatchObject({ code: "migrate_import_failed", detail: "python_data_absent" });
    expect(readdirSync(empty.dataDir)).toEqual(["desktop-electron"]);

    const unknown = fixture();
    writeFileSync(join(unknown.dataDir, "notes.txt"), "synthetic", { mode: 0o600 });
    const before = treeHashes(unknown.dataDir, [...PYTHON_NAMES, "notes.txt"]);
    let asked = false;
    expect(
      await failure(
        migrateInPlace({
          dataDir: unknown.dataDir,
          at: AT,
          keychain: unknown.keychain,
          async saveRecoveryWords() {
            asked = true;
          },
        }),
      ),
    ).toMatchObject({ code: "migrate_import_failed", detail: "semantic_difference" });
    expect(asked).toBe(false);
    expect(treeHashes(unknown.dataDir, [...PYTHON_NAMES, "notes.txt"])).toEqual(before);
    expect(readdirSync(unknown.dataDir).some((name) => name.startsWith(".migration-"))).toBe(false);

    const busy = fixture();
    mkdirSync(join(busy.dataDir, "run"), { mode: 0o700 });
    const lock = acquireHostLock(hostRunPaths(busy.dataDir).lockPath);
    try {
      expect(
        await failure(
          migrateInPlace({
            dataDir: busy.dataDir,
            at: AT,
            keychain: busy.keychain,
            saveRecoveryWords: async () => {},
          }),
        ),
      ).toMatchObject({ code: "migrate_import_failed", detail: "native_host_lock_required" });
    } finally {
      lock?.release();
    }
    expect(busy.items.size).toBe(0);
  });
});
