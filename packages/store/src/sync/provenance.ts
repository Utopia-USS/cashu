// Device-local key provenance (which device sent each vault key, to whom, how). Portable: the binding
// digest is sha256 over the ring's gid salt through @noble/hashes, byte-identical to the node:crypto
// digest the host wrote before this store moved here (pinned by provenance.vector.test.ts).
import type { crypto, devices } from "@cashu/sync/engine";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { SqlDriver } from "../sql/driver.js";

const KID = /^[0-9a-f]{32}$/;
const DEVICE = /^[0-9a-f]{32}$/;

export class ProvenanceRefusal extends Error {
  readonly code: "missing_provenance" | "corrupt_provenance" | "provenance_mismatch";
  constructor(code: "missing_provenance" | "corrupt_provenance" | "provenance_mismatch") {
    super(code);
    this.code = code;
  }
}

type Row = {
  kid: string;
  generation: number;
  epoch: number;
  sender: string;
  recipients: string | null;
  source: string;
  received_at: number;
};

/** Hex sha256 of the gid salt: ties the store to one vault's keyring without holding the salt. */
function ringBinding(salt: crypto.Secret): string {
  return bytesToHex(sha256(salt.expose()));
}

function validRecord(value: devices.KeyProvenance): boolean {
  return (
    KID.test(value.kid) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    Number.isSafeInteger(value.epoch) &&
    value.epoch >= 0 &&
    DEVICE.test(value.sender) &&
    (value.recipients === null ||
      (Array.isArray(value.recipients) && value.recipients.every((id) => DEVICE.test(id)))) &&
    (value.source === "own" || value.source === "wrap" || value.source === "pairing") &&
    Number.isSafeInteger(value.receivedAt) &&
    value.receivedAt >= 0
  );
}

function decode(row: Row): devices.KeyProvenance {
  let recipients: unknown = null;
  try {
    if (row.recipients !== null) recipients = JSON.parse(row.recipients);
  } catch {
    throw new ProvenanceRefusal("corrupt_provenance");
  }
  const record: devices.KeyProvenance = {
    kid: row.kid,
    generation: row.generation,
    epoch: row.epoch,
    sender: row.sender,
    recipients: recipients as readonly string[] | null,
    source: row.source as devices.KeySource,
    receivedAt: row.received_at,
  };
  if (!validRecord(record)) throw new ProvenanceRefusal("corrupt_provenance");
  return record;
}

/** Device-local security metadata. Use a private durable DB, never a replaceable view DB. */
export class SqlProvenanceStore implements devices.ProvenanceStore {
  readonly #driver: SqlDriver;
  readonly #binding: string;

  private constructor(driver: SqlDriver, binding: string) {
    this.#driver = driver;
    this.#binding = binding;
  }

  static open(
    driver: SqlDriver,
    ring: crypto.Keyring,
    mode: "existing" | "new",
  ): SqlProvenanceStore {
    const salt = ring.gidSalt();
    let binding: string;
    try {
      binding = ringBinding(salt);
    } finally {
      salt.wipe();
    }
    const expected = `${ring.vaultId}:${binding}`;
    const table = driver.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    );
    const hasMeta = table.get("vault_key_provenance_meta") !== undefined;
    const hasRows = table.get("vault_key_provenance") !== undefined;
    if (mode === "existing" && (!hasMeta || !hasRows)) {
      throw new ProvenanceRefusal("missing_provenance");
    }
    if (hasMeta !== hasRows) throw new ProvenanceRefusal("corrupt_provenance");
    if (mode === "new" && hasMeta) throw new ProvenanceRefusal("provenance_mismatch");
    if (mode === "new") {
      driver.transaction(() => {
        driver.exec(`CREATE TABLE vault_key_provenance_meta (
          format INTEGER NOT NULL, binding TEXT NOT NULL
        );
        CREATE TABLE vault_key_provenance (
          kid TEXT PRIMARY KEY NOT NULL, generation INTEGER NOT NULL, epoch INTEGER NOT NULL,
          sender TEXT NOT NULL, recipients TEXT, source TEXT NOT NULL, received_at INTEGER NOT NULL
        ) WITHOUT ROWID;`);
        driver.prepare("INSERT INTO vault_key_provenance_meta VALUES (1, ?)").run(expected);
      });
    }
    const meta = driver.prepare("SELECT format, binding FROM vault_key_provenance_meta").all<{
      format: number;
      binding: string;
    }>();
    if (meta.length !== 1 || meta[0]?.format !== 1) {
      throw new ProvenanceRefusal("corrupt_provenance");
    }
    if (meta[0].binding !== expected) throw new ProvenanceRefusal("provenance_mismatch");
    const store = new SqlProvenanceStore(driver, expected);
    const records = store.list();
    const held = ring.entries();
    if (mode === "existing") {
      if (
        held.some((key) => {
          const record = records.find((candidate) => candidate.kid === key.kid);
          return !record || record.generation !== key.generation || record.epoch !== key.epoch;
        })
      ) {
        throw new ProvenanceRefusal("missing_provenance");
      }
    }
    return store;
  }

  assertRing(ring: crypto.Keyring): void {
    const salt = ring.gidSalt();
    try {
      const binding = `${ring.vaultId}:${ringBinding(salt)}`;
      if (binding !== this.#binding) throw new ProvenanceRefusal("provenance_mismatch");
    } finally {
      salt.wipe();
    }
  }

  get(kid: string): devices.KeyProvenance | undefined {
    const row = this.#driver
      .prepare("SELECT * FROM vault_key_provenance WHERE kid = ?")
      .get<Row>(kid);
    return row === undefined ? undefined : decode(row);
  }

  put(record: devices.KeyProvenance): void {
    if (!validRecord(record)) throw new ProvenanceRefusal("corrupt_provenance");
    if (this.get(record.kid)) return;
    this.#driver
      .prepare(`INSERT OR IGNORE INTO vault_key_provenance
      (kid, generation, epoch, sender, recipients, source, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.kid,
        record.generation,
        record.epoch,
        record.sender,
        record.recipients === null ? null : JSON.stringify(record.recipients),
        record.source,
        record.receivedAt,
      );
  }

  list(): readonly devices.KeyProvenance[] {
    return this.#driver
      .prepare("SELECT * FROM vault_key_provenance ORDER BY generation, kid")
      .all<Row>()
      .map(decode);
  }
}
