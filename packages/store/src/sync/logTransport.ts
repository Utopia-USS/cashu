// A device's local copy of one vault's sync log in SQLite: the phone's own-log store (the desktop keeps
// it in a folder). Segments are append-only byte streams per (device, seg); each append is one chunk
// row, and the segment size moves by a conditional UPDATE in the same transaction, so a concurrent or
// retried append at a stale offset changes nothing and surfaces as `offset-conflict`.
import {
  type DeviceId,
  type SegmentInfo,
  type Transport,
  type TransportConsistency,
  TransportError,
  type VaultId,
} from "@cashu/sync";
import { DEVICE_RE } from "@cashu/sync/hlc";
import { concatBytes } from "@noble/hashes/utils.js";
import type { SqlDriver, SqlStatement } from "../sql/driver.js";

const DDL = `CREATE TABLE IF NOT EXISTS log_segments (
  device TEXT NOT NULL, seg INTEGER NOT NULL, size INTEGER NOT NULL,
  PRIMARY KEY (device, seg)
) STRICT;
CREATE TABLE IF NOT EXISTS log_chunks (
  device TEXT NOT NULL, seg INTEGER NOT NULL, start INTEGER NOT NULL, bytes BLOB NOT NULL,
  PRIMARY KEY (device, seg, start)
) STRICT;`;

const EMPTY = new Uint8Array(0);

export interface SqlLogTransportOptions {
  readonly driver: SqlDriver;
  /** The one vault this database holds; every call names it. */
  readonly vault: VaultId;
}

interface Statements {
  readonly list: SqlStatement;
  readonly read: SqlStatement;
  readonly createSegment: SqlStatement;
  readonly grow: SqlStatement;
  readonly insertChunk: SqlStatement;
}

export class SqlLogTransport implements Transport {
  readonly consistency: TransportConsistency = { kind: "linearizable" };
  readonly #driver: SqlDriver;
  readonly #vault: VaultId;
  #statements: Statements | undefined;

  constructor(options: SqlLogTransportOptions) {
    this.#driver = options.driver;
    this.#vault = options.vault;
  }

  /** Create the log tables when missing. Call once after opening the database. */
  ensureSchema(): void {
    this.#driver.exec(DDL);
  }

  async list(vault: VaultId): Promise<readonly SegmentInfo[]> {
    this.#checkVault(vault);
    return this.#sql()
      .list.all<{ device: string; seg: number; size: number }>()
      .map((r) => ({
        device: r.device,
        seg: r.seg,
        size: r.size,
      }));
  }

  async read(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    fromOffset: number,
  ): Promise<Uint8Array> {
    this.#checkVault(vault);
    checkSegment(device, seg);
    if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) throw new RangeError("log_offset");
    const rows = this.#sql().read.all<{ start: number; bytes: Uint8Array }>(
      device,
      seg,
      fromOffset,
    );
    const first = rows[0];
    if (!first) return EMPTY;
    const all = rows.length === 1 ? first.bytes : concatBytes(...rows.map((r) => r.bytes));
    // One native copy into a plain Uint8Array (never a driver Buffer view; `Uint8Array.from` copies
    // element by element on Hermes and the engine reads whole segments).
    return new Uint8Array(all.subarray(fromOffset - first.start));
  }

  async append(
    vault: VaultId,
    device: DeviceId,
    seg: number,
    atOffset: number,
    bytes: Uint8Array,
  ): Promise<void> {
    this.#checkVault(vault);
    checkSegment(device, seg);
    if (!Number.isSafeInteger(atOffset) || atOffset < 0) throw new RangeError("log_offset");
    if (bytes.length < 1) throw new RangeError("log_append_empty");
    const sql = this.#sql();
    this.#driver.transaction(() => {
      if (atOffset === 0) sql.createSegment.run(device, seg);
      if (sql.grow.run(bytes.length, device, seg, atOffset).changes !== 1) {
        throw new TransportError("offset-conflict", "append offset is not the segment size");
      }
      // The driver copies the bytes into SQLite inside `run`; no extra copy of the caller's view.
      sql.insertChunk.run(device, seg, atOffset, bytes);
    });
  }

  #checkVault(vault: VaultId): void {
    if (vault !== this.#vault) throw new Error("log_transport_vault");
  }

  #sql(): Statements {
    this.#statements ??= {
      list: this.#driver.prepare("SELECT device, seg, size FROM log_segments"),
      read: this.#driver.prepare(
        "SELECT start, bytes FROM log_chunks WHERE device = ? AND seg = ? AND start + length(bytes) > ? ORDER BY start",
      ),
      createSegment: this.#driver.prepare(
        "INSERT INTO log_segments (device, seg, size) VALUES (?, ?, 0) ON CONFLICT (device, seg) DO NOTHING",
      ),
      grow: this.#driver.prepare(
        "UPDATE log_segments SET size = size + ? WHERE device = ? AND seg = ? AND size = ?",
      ),
      insertChunk: this.#driver.prepare(
        "INSERT INTO log_chunks (device, seg, start, bytes) VALUES (?, ?, ?, ?)",
      ),
    };
    return this.#statements;
  }
}

function checkSegment(device: DeviceId, seg: number): void {
  if (!DEVICE_RE.test(device)) throw new RangeError("log_device");
  if (!Number.isSafeInteger(seg) || seg < 1) throw new RangeError("log_segment");
}
