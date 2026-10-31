// Genesis device, clock and eids (S26 spec 5.2-5.3, gid.md 7.1, impl notes change 1). Everything is
// derived from the vault salt and the data: the genesis device is a per-vault pseudo-device (HMAC of
// the salt), the base wall W is 1 + the newest happened-at timestamp of the vault's rows, event n has
// the HLC (W + floor(n / 36^4), n mod 36^4, device), and each eid is a ULID at W whose random part is
// an HMAC of (type, gid, k). Two runs on one database with one salt therefore give the same log. The
// caller's clock enters only the `clock_skew` guard.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { formatHlc, HLC_COUNTER_MAX } from "../events/v1/hlc-format.js";
import { UNIT_SEPARATOR } from "../events/v1/namespaces.js";
import { TIMESTAMP_RE } from "../events/v1/primitives.js";
import { mintUlid, type VaultSalt } from "../gid.js";
import { GenesisError } from "./report.js";

const utf8 = new TextEncoder();
const DEVICE_LABEL = "cashu.genesis.device.v1";
const EID_LABEL = "cashu.genesis.eid.v1";
/** HLC counters per wall millisecond (36^4): event n lands on wall W + floor(n / this). */
const COUNTERS_PER_WALL = HLC_COUNTER_MAX + 1;
/** events.md 3.3: the clock skew a device tolerates; a W further ahead of `now` fails the run. */
const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Columns and payload keys that hold planned (future-dated) times, not "happened at" times: they
 * never raise W (gid.md 7.1), or a snooze until next year would put genesis ahead of every edit.
 */
const FUTURE_TIMES: ReadonlySet<string> = new Set([
  "expires_at",
  "snoozed_until",
  "cooldown_until",
  "expiresAt",
  "snoozedUntil",
  "cooldownUntil",
  "until",
]);

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/**
 * The genesis device id of a vault: the first 16 bytes of HMAC-SHA256(salt, "cashu.genesis.device.v1")
 * as 32 lower-case hex. The all-zero id (the recovery signer's) is refused.
 */
export function genesisDevice(salt: VaultSalt): string {
  const digest = hmac(sha256, salt.bytes, utf8.encode(DEVICE_LABEL));
  let out = "";
  for (let i = 0; i < 16; i++) out += HEX[digest[i] as number];
  if (!/[1-9a-f]/.test(out)) throw new RangeError("the genesis device id must not be all zero");
  return out;
}

/** Milliseconds since the epoch of a payload timestamp (`YYYY-MM-DDTHH:MM:SS[.f]Z`), fraction floored. */
function timestampMs(value: string): number {
  const m = TIMESTAMP_RE.exec(value);
  if (m === null) throw new RangeError("not a genesis timestamp");
  const fraction = (m[7] ?? "").slice(1);
  const ms = Number(fraction.padEnd(3, "0").slice(0, 3));
  return (
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    ) + ms
  );
}

/**
 * The base wall W of a vault (gid.md 7.1): 1 + the newest happened-at timestamp among `stamps`
 * (`[column or payload key, value]` pairs of every exported row, nulls allowed), the future-dated
 * columns skipped. Fails `clock_skew` when W is more than 5 minutes ahead of `now` (the only use of
 * the caller's clock).
 */
export function genesisWall(
  stamps: Iterable<readonly [name: string, value: string | null]>,
  now: number,
): number {
  let newest: number | undefined;
  for (const [name, value] of stamps) {
    if (value === null || FUTURE_TIMES.has(name)) continue;
    const ms = timestampMs(value);
    if (newest === undefined || ms > newest) newest = ms;
  }
  if (newest === undefined) throw new RangeError("a genesis vault has at least its profile stamp");
  const wall = newest + 1;
  if (wall > now + MAX_SKEW_MS) {
    throw new GenesisError("clock_skew", "the newest timestamp of a vault is ahead of the clock");
  }
  return wall;
}

/** The HLC of the n-th event (n = 0, 1, ...) of a vault with base wall W (gid.md 7.1). */
export function genesisHlc(wall: number, n: number, device: string): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("event indexes are counts");
  return formatHlc({
    wall: wall + Math.floor(n / COUNTERS_PER_WALL),
    counter: n % COUNTERS_PER_WALL,
    device,
  });
}

/**
 * The eid of an event (gid.md 7.1): ULID(time = W, random = the first 10 bytes of
 * HMAC-SHA256(salt, "cashu.genesis.eid.v1" US type US gid US k)), k = the index of the event among
 * the vault's events with the same (type, gid).
 */
export function genesisEid(
  salt: VaultSalt,
  wall: number,
  type: string,
  gid: string,
  k: number,
): string {
  const message = [EID_LABEL, type, gid, String(k)].join(UNIT_SEPARATOR);
  const digest = hmac(sha256, salt.bytes, utf8.encode(message));
  return mintUlid(wall, (n) => digest.slice(0, n));
}

/** `at` of every genesis event: W as `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
function wallIso(wall: number): string {
  return new Date(wall).toISOString();
}

/**
 * The clock of one vault's genesis log: hands out (hlc, eid) for events in log order. The caller
 * computes W with `genesisWall` and emits every event of the vault through one instance.
 */
export class GenesisClock {
  readonly device: string;
  readonly wall: number;
  /** `at` of every event of the vault. */
  readonly at: string;
  readonly #salt: VaultSalt;
  readonly #seen = new Map<string, number>();
  #n = 0;

  constructor(salt: VaultSalt, wall: number) {
    this.#salt = salt;
    this.device = genesisDevice(salt);
    this.wall = wall;
    this.at = wallIso(wall);
  }

  /** The HLC and eid of the next event of the log. */
  next(type: string, gid: string): { readonly hlc: string; readonly eid: string } {
    const key = `${type}${UNIT_SEPARATOR}${gid}`;
    const k = this.#seen.get(key) ?? 0;
    this.#seen.set(key, k + 1);
    const hlc = genesisHlc(this.wall, this.#n, this.device);
    this.#n += 1;
    return { hlc, eid: genesisEid(this.#salt, this.wall, type, gid, k) };
  }
}
