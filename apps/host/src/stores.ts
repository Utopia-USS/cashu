// The stores this host opens: the device store and every vault the device holds, each with its write
// queue and request-key table. Files are opened exclusively under the writer lease (WAL +
// `locking_mode=EXCLUSIVE`): any other process opening one gets "database is locked" instead of
// forking a device stream. A damaged vault database is discarded and reopened empty
// (`Store.openOrRecover`; after a session that did not close cleanly the store runs `quick_check`).
//
// TRANSITIONAL(S53b): vaults come from a synthetic source, as in S53's store process: a device id
// file, one database and one gid-salt file per vault under `<data dir>/stores/`, a demo vault seeded
// on first run, commands applied straight to the view (HLC state saved with each batch). The real
// source opens each vault the device holds with its gid salt from the OS keyring (S56e), its device
// identity from pairing (S29), and writes through the sync engine's durable local append (S29c-B3),
// which also replays a recovered view from the log.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  type CommandEnv,
  createProfile,
  type EventWriter,
  HybridClock,
  isCorruption,
  metaClockStore,
  runCommand,
  type SqlDriver,
  Store,
  vaultSalt,
} from "@cashu/store";
import { currentVault, DeviceStore, setCurrentVault } from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import type { WriterLease } from "./lease.js";
import type { HostLog } from "./log.js";
import { WriteQueue } from "./queue.js";
import { RequestTable } from "./requests.js";

const HEX32 = /^[0-9a-f]{32}$/;

/** One vault open on this device. */
export interface OpenVault {
  readonly id: string;
  readonly store: Store;
  readonly driver: SqlDriver;
  /** How this device's commands append (the sync engine's local append, S29c-B3). */
  readonly writer: EventWriter;
  readonly env: CommandEnv;
  readonly queue: WriteQueue;
  readonly requests: RequestTable;
}

export interface OpenDevice {
  readonly store: DeviceStore;
  readonly driver: SqlDriver;
  readonly queue: WriteQueue;
  readonly requests: RequestTable;
}

export interface HostStores {
  readonly device: OpenDevice;
  readonly vaults: ReadonlyMap<string, OpenVault>;
  /** Vaults found damaged at open and reopened empty. */
  readonly recovered: number;
  /** Write tasks queued or running, all stores together. */
  pending(): number;
  /** Refuses new writes and resolves when every queue drained. */
  drain(): Promise<void>;
  close(): void;
}

export interface StoreFiles {
  /** `<data dir>/stores` */
  readonly dir: string;
  readonly vaultDir: string;
  readonly deviceDb: string;
  readonly deviceId: string;
}

export function storeFiles(dataDir: string): StoreFiles {
  const dir = join(dataDir, "stores");
  return {
    dir,
    vaultDir: join(dir, "vaults"),
    deviceDb: join(dir, "device.db"),
    deviceId: join(dir, "device-id"),
  };
}

/** A hex value in a file only the owner can read, created on first use. */
function hexFile(path: string, bytes: number): string {
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) return value;
    throw new Error("an unreadable store key file");
  }
  const value = randomBytes(bytes).toString("hex");
  writeFileSync(path, `${value}\n`, { mode: 0o600, flag: "wx" });
  return value;
}

/** Creates an empty database file with mode 0600 (SQLite keeps an existing file's mode for its WAL). */
function privateDbFile(path: string): string {
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  return path;
}

const discardDb = (path: string) => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
};

function openVault(
  files: StoreFiles,
  id: string,
  device: string,
  lease: WriterLease,
  now: () => number,
): { vault: OpenVault; recovered: boolean } {
  const path = join(files.vaultDir, `${id}.db`);
  const salt = Uint8Array.from(Buffer.from(hexFile(join(files.vaultDir, `${id}.salt`), 32), "hex"));
  let driver: SqlDriver | undefined;
  const { store, recovered } = Store.openOrRecover({
    vault: id,
    salt: vaultSalt(salt),
    modules: builtinModules(),
    connect: () => {
      driver = openNodeSqlite(privateDbFile(path), { exclusive: lease.lock() });
      return driver;
    },
    discard: () => discardDb(path),
  });
  const db = driver as SqlDriver;
  const clockStore = metaClockStore(db, device);
  const restored = clockStore.load();
  const hlc = new HybridClock(device, restored === undefined ? {} : { restore: restored });
  return {
    recovered,
    vault: {
      id,
      store,
      driver: db,
      writer: {
        append(envelopes) {
          clockStore.save(hlc.state);
          store.applyEnvelopes(envelopes);
        },
      },
      env: { device, clock: { now }, hlc, lease: { isHolder: () => true } },
      queue: new WriteQueue(() => lease.assertHeld()),
      requests: new RequestTable(db, now),
    },
  };
}

function openDevice(files: StoreFiles, lease: WriterLease, log: HostLog): DeviceStore {
  const connect = () => {
    const driver = openNodeSqlite(privateDbFile(files.deviceDb), { exclusive: lease.lock() });
    driver.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    return driver;
  };
  let driver = connect();
  try {
    return DeviceStore.open(driver);
  } catch (error) {
    if (!isCorruption(error)) throw error;
    // Device-local settings only (current profile, device settings): start over.
    log.warn("device.recovered");
    driver.close();
    discardDb(files.deviceDb);
    driver = connect();
    return DeviceStore.open(driver);
  }
}

/** Opens the device store and the vaults under `<data dir>/stores` (seeding a demo vault once). */
export function openHostStores(
  dataDir: string,
  lease: WriterLease,
  log: HostLog,
  now: () => number = Date.now,
): HostStores {
  const files = storeFiles(dataDir);
  ensurePrivateDir(files.dir);
  ensurePrivateDir(files.vaultDir);
  const deviceId = hexFile(files.deviceId, 16);
  const deviceStore = openDevice(files, lease, log);
  const device: OpenDevice = {
    store: deviceStore,
    driver: deviceStore.driver,
    queue: new WriteQueue(() => lease.assertHeld()),
    requests: new RequestTable(deviceStore.driver, now),
  };

  const vaults = new Map<string, OpenVault>();
  let recovered = 0;
  const close = () => {
    for (const v of vaults.values()) v.store.close();
    deviceStore.close();
  };
  try {
    const ids = readdirSync(files.vaultDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => f.slice(0, -3))
      .filter((id) => HEX32.test(id))
      .sort();
    for (const id of ids) {
      const opened = openVault(files, id, deviceId, lease, now);
      vaults.set(id, opened.vault);
      if (opened.recovered) recovered += 1;
    }
    if (vaults.size === 0) {
      const id = randomBytes(16).toString("hex");
      const { vault } = openVault(files, id, deviceId, lease, now);
      vaults.set(id, vault);
      const seeded = runCommand(
        vault.store,
        vault.writer,
        createProfile,
        { slug: "demo", name: "Demo" },
        vault.env,
      );
      if (!seeded.ok) throw new Error(`the demo vault was not seeded (${seeded.reason})`);
    }
    const current = runQuery(deviceStore, currentVault, undefined).value;
    const first = [...vaults.keys()][0];
    if ((current === null || !vaults.has(current)) && first !== undefined) {
      const switched = deviceStore.run(setCurrentVault, { vault: first });
      if (!switched.ok) throw new Error(`the current vault was not set (${switched.reason})`);
    }
    for (const t of [device, ...vaults.values()]) t.requests.prune();
  } catch (error) {
    close();
    throw error;
  }

  const queues = () => [device.queue, ...[...vaults.values()].map((v) => v.queue)];
  return {
    device,
    vaults,
    recovered,
    pending: () => queues().reduce((n, q) => n + q.pending, 0),
    async drain() {
      for (const q of queues()) q.close();
      await Promise.all(queues().map((q) => q.idle()));
    },
    close,
  };
}
