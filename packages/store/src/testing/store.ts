// Test helpers: an in-memory store on better-sqlite3 and a deterministic event factory. Synthetic
// data only.
import Database from "better-sqlite3";
import { formatHlc } from "../events/v1/hlc-format.js";
import { vaultSalt } from "../gid.js";
import { Store } from "../materialize.js";
import { builtinModules } from "../modules.js";
import type { StoreModule } from "../registry.js";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import type { SqlDriver } from "../sql/driver.js";

export const TEST_VAULT = "5f0c3a9e81d24b7690ae13c7d2f4b856";
/** The gid.md section 8 test salt (bytes 00..1f). Real salts are random. */
export const TEST_SALT = vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => i));
const BASE_WALL = 1_793_448_000_000; // 2026-10-31T12:00:00.000Z

/** A new, empty in-memory database. */
export function memoryDriver(): SqlDriver {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  return betterSqlite3Driver(db);
}

/** Images of an empty test vault database (opened once by `Store.open`), one per module list. */
const emptyVaults = new Map<string, { modules: readonly StoreModule[]; image: Buffer }>();

/**
 * A new in-memory copy of an empty TEST_VAULT database that `Store.open` already initialised with
 * `modules`, so a test that opens hundreds of stores reopens an existing empty vault (the path every
 * app start takes) instead of creating ~70 tables each time. The new-database path is covered by
 * the tests that pass `memoryDriver()`.
 */
function emptyVaultDriver(modules: readonly StoreModule[]): SqlDriver {
  const key = modules.map((m) => m.id).join(",");
  let t = emptyVaults.get(key);
  if (t === undefined || t.modules.some((m, i) => m !== modules[i])) {
    const db = new Database(":memory:");
    Store.open({
      driver: betterSqlite3Driver(db),
      vault: TEST_VAULT,
      salt: TEST_SALT,
      modules,
    }).detach();
    t = { modules, image: db.serialize() };
    db.close();
    emptyVaults.set(key, t);
  }
  // A deserialized database lives in memory, journal included (what `memoryDriver` sets).
  return betterSqlite3Driver(new Database(t.image));
}

export function openTestStore(
  options: { driver?: SqlDriver; modules?: readonly StoreModule[] } = {},
): Store {
  const modules = options.modules ?? builtinModules();
  return Store.open({
    driver: options.driver ?? emptyVaultDriver(modules),
    vault: TEST_VAULT,
    salt: TEST_SALT,
    modules,
  });
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A valid ULID from a counter (sortable by the counter within one prefix). */
export function testUlid(prefix: string, n: number): string {
  let s = "";
  let x = n;
  do {
    s = CROCKFORD.charAt(x % 32) + s;
    x = Math.floor(x / 32);
  } while (x > 0);
  return (prefix + s.padStart(26 - prefix.length, "0")).slice(0, 26);
}

export interface TestEnvelope {
  eid: string;
  vault: string;
  device: string;
  hlc: string;
  at: string;
  type: string;
  v: number;
  gid: string;
  data: Record<string, unknown>;
  cause?: string;
  [extra: string]: unknown;
}

/** Builds logical envelopes with increasing eids; `wall` is ms after BASE_WALL. */
export class EventFactory {
  #seq = 0;
  readonly device: string;
  readonly prefix: string;
  constructor(device = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", prefix = "01JC") {
    this.device = device;
    this.prefix = prefix;
  }

  make(
    type: string,
    gid: string,
    data: Record<string, unknown>,
    opts: { wall?: number; counter?: number; cause?: string; v?: number; device?: string } = {},
  ): TestEnvelope {
    this.#seq += 1;
    const device = opts.device ?? this.device;
    const wall = BASE_WALL + (opts.wall ?? this.#seq);
    return {
      eid: testUlid(this.prefix, this.#seq),
      vault: TEST_VAULT,
      device,
      hlc: formatHlc({ wall, counter: opts.counter ?? 0, device }),
      at: new Date(wall).toISOString(),
      type,
      v: opts.v ?? 1,
      gid,
      data,
      ...(opts.cause === undefined ? {} : { cause: opts.cause }),
    };
  }
}
