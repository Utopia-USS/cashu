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

export const TEST_VAULT = "01JC0Z8Y3K7M4N5P6Q8R9S0T1V";
/** The gid.md section 8 test salt (bytes 00..1f). Real salts are random. */
export const TEST_SALT = vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => i));
const BASE_WALL = 1_793_448_000_000; // 2026-10-31T12:00:00.000Z

export function memoryDriver(): SqlDriver {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  return betterSqlite3Driver(db);
}

export function openTestStore(
  options: { driver?: SqlDriver; modules?: readonly StoreModule[] } = {},
): Store {
  return Store.open({
    driver: options.driver ?? memoryDriver(),
    vault: TEST_VAULT,
    salt: TEST_SALT,
    modules: options.modules ?? builtinModules(),
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
  constructor(
    readonly device = "aaaaaaaaaaaaaaaa",
    readonly prefix = "01JC",
  ) {}

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

/** Deterministic PRNG (mulberry32) and a seeded shuffle. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Split into consecutive batches of random size 1..max. */
export function chunked<T>(xs: readonly T[], seed: number, max = 4): T[][] {
  const r = rng(seed);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; ) {
    const n = 1 + Math.floor(r() * max);
    out.push(xs.slice(i, i + n));
    i += n;
  }
  return out;
}
