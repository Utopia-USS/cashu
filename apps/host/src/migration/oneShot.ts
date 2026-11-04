import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { acquireHostLock, hostRunPaths } from "@cashu/node-host";
import { PYTHON_BACKUP_PREFIX } from "@cashu/node-host/admission";
import { createProductionKeyStore } from "@cashu/node-host/keyring";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { vaultSalt, viewHash } from "@cashu/store";
import { DeviceStore } from "@cashu/store/device";
import { publishCheckedImportBlob } from "@cashu/store/investments/services";
import { crypto } from "@cashu/sync";
import { takeWriterLease } from "../lease.js";
import { NativeBlobPublication } from "../nativeBlobs.js";
import { NATIVE_INVENTORY, readExistingNativeInventory } from "../nativeInventory.js";
import { openNativeVault } from "../nativeVault.js";
import { ProductionVaultSourceFactory } from "../productionVaultSource.js";
import { MigrationError } from "./contract.js";
import { convertStrictGenesis } from "./convert.js";
import { hydrateLocalState, type LocalStateProof, verifyHydratedLocalState } from "./localState.js";
import { createMigrationIdentitySet } from "./publication/identity.js";
import { provisionMigrationKeyStore } from "./publication/keyStore.js";
import { writeEncryptedMigrationVault } from "./publication/vault.js";
import { captureOfflineSnapshot } from "./snapshot.js";
import { assertSameSource, type PythonDatabaseName, sealPythonSource } from "./sourceSeal.js";
import { collectStagedProposalBlobs, type StagedProposalBlob } from "./stagedBlobs.js";
import { verifyStrictCoreReplay } from "./verify.js";

export type KeyStoreFactory = typeof createProductionKeyStore;

export interface OneShotInput {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly at: number;
  /** Save the one-use recovery words before target artifacts are created. */
  readonly saveRecoveryWords: (words: string) => Promise<void>;
  /** Synthetic test OS namespace only. Production always uses the constrained OS provider. */
  readonly makeKeyStore?: KeyStoreFactory;
}

export interface OneShotResult {
  readonly profiles: number;
  readonly financialTables: number;
  readonly financialRows: number;
  readonly vaults: readonly { ordinal: number; vaultId: string; viewHash: string }[];
}

function canonical(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0"))
    throw new MigrationError("source_unsafe");
  return path;
}

function disjoint(source: string, target: string): void {
  const path = relative(source, target);
  if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)))
    throw new MigrationError("source_unsafe");
  const reverse = relative(target, source);
  if (
    reverse === "" ||
    (reverse !== ".." && !reverse.startsWith(`..${sep}`) && !isAbsolute(reverse))
  )
    throw new MigrationError("source_unsafe");
}

function freshDirectory(path: string): void {
  canonical(path);
  if (realpathSync(dirname(path)) !== dirname(path)) throw new MigrationError("source_unsafe");
  mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)
    throw new MigrationError("source_unsafe");
}

function assertAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new MigrationError("identity_invalid");
}

function databaseName(source: string): PythonDatabaseName {
  const present = (name: PythonDatabaseName) => {
    try {
      lstatSync(join(source, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const cashu = present("cashu.db");
  const finanse = present("finanse.db");
  if (cashu === finanse) throw new MigrationError("source_unsafe");
  return cashu ? "cashu.db" : "finanse.db";
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function withDeviceStore<T>(
  dataDir: string,
  lock: NonNullable<ReturnType<typeof acquireHostLock>>,
  create: boolean,
  use: (store: DeviceStore) => T,
): T {
  if (!lock.held) throw new MigrationError("identity_invalid");
  const dir = join(dataDir, "stores");
  if (create) freshDirectory(dir);
  const path = join(dir, "device.db");
  if (create) {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dir);
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new MigrationError("identity_invalid");
  const driver = openNodeSqlite(path, { exclusive: lock });
  let store: DeviceStore | undefined;
  try {
    driver.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    store = DeviceStore.open(driver);
    return use(store);
  } finally {
    if (store) store.close();
    else driver.close();
  }
}

function verifyDeviceLocal(
  dataDir: string,
  conversion: ReturnType<typeof convertStrictGenesis>,
  expected?: LocalStateProof,
): void {
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new MigrationError("identity_invalid");
  try {
    withDeviceStore(dataDir, lock, false, (store) =>
      verifyHydratedLocalState(store.driver, conversion, expected),
    );
  } finally {
    lock.release();
  }
}

function writeInventory(
  dataDir: string,
  vaults: readonly { vaultId: string; deviceId: string }[],
): void {
  const native = join(dataDir, "native");
  const version = join(native, "v1");
  freshDirectory(native);
  freshDirectory(version);
  const bytes = Buffer.from(
    JSON.stringify({
      format: 1,
      vaults: vaults.map(({ vaultId, deviceId }) => ({
        vaultId,
        deviceId,
        state: "ready",
        enrollment: "creator",
      })),
    }),
  );
  if (bytes.length > 64 * 1024) throw new MigrationError("identity_invalid");
  const fd = openSync(
    join(dataDir, NATIVE_INVENTORY),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new MigrationError("identity_invalid");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(version);
  fsyncDirectory(native);
  readExistingNativeInventory(dataDir);
}

function sourceSlugs(snapshot: string): string[] {
  const db = openNodeSqlite(join(snapshot, "cashu.db"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT slug FROM profiles ORDER BY id").all<{ slug: string }>();
    return rows.map((row) => row.slug);
  } finally {
    db.close();
  }
}

function staging(): { root: string; snapshot: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-migrate-")));
  const stat = lstatSync(root);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700)
    throw new MigrationError("source_unsafe");
  return { root, snapshot: join(root, "snapshot") };
}

async function verifyPublished(
  dataDir: string,
  expected: readonly { ordinal: number; viewHash: string }[],
  makeKeyStore: KeyStoreFactory,
  at: number,
  blobs: readonly StagedProposalBlob[],
): Promise<void> {
  const factory = new ProductionVaultSourceFactory(dataDir, makeKeyStore);
  factory.preflight();
  const run = hostRunPaths(dataDir);
  const lock = acquireHostLock(run.lockPath);
  if (!lock) throw new MigrationError("identity_invalid");
  try {
    const source = await factory.open(lock);
    const sodium = await crypto.loadNodeSodium();
    const keyStore = makeKeyStore({
      dataDir,
      purpose: "open",
      authorizedNames: new Set(source.inventory.map((entry) => crypto.keyringName(entry.vaultId))),
      sodium,
    });
    if (source.inventory.length !== expected.length) throw new MigrationError("replay_mismatch");
    for (const [ordinal, entry] of source.inventory.entries()) {
      const match = expected[ordinal];
      if (!match || match.ordinal !== ordinal) throw new MigrationError("replay_mismatch");
      const session = await openNativeVault(
        entry,
        dataDir,
        source,
        takeWriterLease(lock),
        () => at,
      );
      try {
        if (viewHash(session.store).hash !== match.viewHash)
          throw new MigrationError("replay_mismatch");
        const referenced = blobs.filter((blob) => blob.vaultId === entry.vaultId);
        if (referenced.length) {
          const ring = await crypto.loadKeyring(keyStore, sodium, entry.vaultId);
          if (!ring) throw new MigrationError("identity_invalid");
          const publication = new NativeBlobPublication({
            dataDir,
            vault: entry.vaultId,
            lock,
            sodium,
            ring,
          });
          try {
            for (const blob of referenced) {
              const actual = await publication.read(entry.vaultId, blob.blob, blob.bytes.length);
              if (
                !actual ||
                actual.length !== blob.bytes.length ||
                actual.some((byte, index) => byte !== blob.bytes[index])
              )
                throw new MigrationError("replay_mismatch");
              actual.fill(0);
            }
          } finally {
            publication.close();
            ring.wipe();
          }
        }
      } finally {
        await session.close();
      }
    }
  } finally {
    lock.release();
  }
}

/** Offline one-shot import. The source must remain stopped; only the private copy is opened by SQLite. */
export async function importPythonDataDir(input: OneShotInput): Promise<OneShotResult> {
  const source = realpathSync(canonical(input.sourceDir));
  const target = canonical(input.targetDir);
  disjoint(source, target);
  assertAbsent(target);
  const database = databaseName(source);
  if (!Number.isSafeInteger(input.at) || Number.isNaN(new Date(input.at).valueOf()))
    throw new MigrationError("mapping_invalid");
  const scratch = staging();
  let identity: ReturnType<typeof createMigrationIdentitySet> | undefined;
  let blobs: readonly StagedProposalBlob[] = [];
  try {
    const frozen = await captureOfflineSnapshot(source, scratch.snapshot, database);
    const sodium = await crypto.loadNodeSodium();
    identity = createMigrationIdentitySet(sodium, sourceSlugs(scratch.snapshot));
    const keys = identity.genesisKeys();
    const conversion = convertStrictGenesis(scratch.snapshot, keys, input.at);
    const proof = verifyStrictCoreReplay(conversion, keys);
    blobs = collectStagedProposalBlobs(conversion);
    assertSameSource(frozen.source, sealPythonSource(source, database));
    assertAbsent(target);
    await input.saveRecoveryWords(identity.takeWords());
    freshDirectory(target);
    freshDirectory(join(target, "run"));
    const run = hostRunPaths(target);
    const lock = acquireHostLock(run.lockPath);
    if (!lock) throw new MigrationError("identity_invalid");
    const makeKeyStore = input.makeKeyStore ?? createProductionKeyStore;
    let localProof: LocalStateProof;
    try {
      await provisionMigrationKeyStore({
        dataDir: target,
        identities: identity,
        lock,
        sodium,
        makeKeyStore,
      });
      for (const [ordinal, vault] of conversion.genesis.vaults.entries()) {
        const candidate = identity.vaults[ordinal];
        if (!candidate || candidate.slug !== vault.slug)
          throw new MigrationError("mapping_invalid");
        await writeEncryptedMigrationVault({
          dataDir: target,
          lock,
          sodium,
          identity: candidate,
          genesis: vault,
          proof,
          recovery: identity.recovery,
          now: () => input.at,
          makeKeyStore,
        });
      }
      for (const candidate of identity.vaults) {
        const vault = candidate.created.ring.vaultId;
        const referenced = blobs.filter((blob) => blob.vaultId === vault);
        if (!referenced.length) continue;
        const publication = new NativeBlobPublication({
          dataDir: target,
          vault,
          lock,
          sodium,
          ring: candidate.created.ring,
        });
        try {
          for (const blob of referenced) {
            const receipt = await publishCheckedImportBlob(publication, vault, {
              name: `${blob.blob.sha256}.${blob.blob.ext}`,
              content: blob.bytes,
            });
            if (receipt.blob.sha256 !== blob.blob.sha256 || receipt.blob.ext !== blob.blob.ext)
              throw new MigrationError("replay_mismatch");
          }
        } finally {
          publication.close();
        }
      }
      localProof = withDeviceStore(target, lock, true, (store) =>
        hydrateLocalState(store.driver, conversion),
      );
      withDeviceStore(target, lock, false, (store) =>
        verifyHydratedLocalState(store.driver, conversion, localProof),
      );
      assertSameSource(frozen.source, sealPythonSource(source, database));
      writeInventory(
        target,
        identity.vaults.map(({ created, creator }) => ({
          vaultId: created.ring.vaultId,
          deviceId: creator.deviceId,
        })),
      );
    } finally {
      lock.release();
    }
    verifyDeviceLocal(target, conversion, localProof);
    await verifyPublished(target, proof.vaults, makeKeyStore, input.at, blobs);
    assertSameSource(frozen.source, sealPythonSource(source, database));
    return {
      profiles: proof.profiles,
      financialTables: proof.tables,
      financialRows: proof.rows,
      vaults: identity.vaults.map((vault, ordinal) => {
        const expected = proof.vaults[ordinal];
        if (!expected) throw new MigrationError("replay_mismatch");
        return { ordinal, vaultId: vault.created.ring.vaultId, viewHash: expected.viewHash };
      }),
    };
  } finally {
    identity?.wipe();
    for (const blob of blobs) blob.bytes.fill(0);
    rmSync(scratch.root, { recursive: true, force: true });
  }
}

/** Re-copy and independently project the source, then compare every ordinary native reopen. */
export async function verifyPythonMigration(
  input: Omit<OneShotInput, "saveRecoveryWords">,
): Promise<OneShotResult> {
  const source = realpathSync(canonical(input.sourceDir));
  const target = realpathSync(canonical(input.targetDir));
  // `migrate verify` after an in-place import reads the backup its cutover left in the target.
  const inPlaceBackup =
    dirname(source) === target && basename(source).startsWith(PYTHON_BACKUP_PREFIX);
  if (!inPlaceBackup) disjoint(source, target);
  const database = databaseName(source);
  const scratch = staging();
  let blobs: readonly StagedProposalBlob[] = [];
  try {
    const frozen = await captureOfflineSnapshot(source, scratch.snapshot, database);
    const inventory = readExistingNativeInventory(target).entries;
    const slugs = sourceSlugs(scratch.snapshot);
    if (inventory.length !== slugs.length) throw new MigrationError("mapping_invalid");
    const sodium = await crypto.loadNodeSodium();
    const makeKeyStore = input.makeKeyStore ?? createProductionKeyStore;
    const names = new Set(
      inventory.flatMap((entry) => [
        crypto.keyringName(entry.vaultId),
        crypto.deviceIdentityName(entry.deviceId),
      ]),
    );
    const keyStore = makeKeyStore({
      dataDir: target,
      purpose: "open",
      authorizedNames: names,
      sodium,
    });
    const keys = new Map<string, { vault: string; salt: ReturnType<typeof vaultSalt> }>();
    try {
      for (const [ordinal, entry] of inventory.entries()) {
        const ring = await crypto.loadKeyring(keyStore, sodium, entry.vaultId);
        if (!ring) throw new MigrationError("identity_invalid");
        const slug = slugs[ordinal];
        if (!slug) throw new MigrationError("mapping_invalid");
        try {
          const saltKey = ring.gidSalt();
          try {
            keys.set(slug, {
              vault: entry.vaultId,
              salt: vaultSalt(saltKey.expose()),
            });
          } finally {
            saltKey.wipe();
          }
        } finally {
          ring.wipe();
        }
      }
      const conversion = convertStrictGenesis(scratch.snapshot, keys, input.at);
      const proof = verifyStrictCoreReplay(conversion, keys);
      blobs = collectStagedProposalBlobs(conversion);
      verifyDeviceLocal(target, conversion);
      await verifyPublished(target, proof.vaults, makeKeyStore, input.at, blobs);
      assertSameSource(frozen.source, sealPythonSource(source, database));
      return {
        profiles: proof.profiles,
        financialTables: proof.tables,
        financialRows: proof.rows,
        vaults: inventory.map((entry, ordinal) => {
          const expected = proof.vaults[ordinal];
          if (!expected) throw new MigrationError("replay_mismatch");
          return { ordinal, vaultId: entry.vaultId, viewHash: expected.viewHash };
        }),
      };
    } finally {
      for (const key of keys.values()) key.salt.bytes.fill(0);
    }
  } finally {
    for (const blob of blobs) blob.bytes.fill(0);
    rmSync(scratch.root, { recursive: true, force: true });
  }
}
