// The sync engine's recovery checkpoint store (`RecoveryCheckpointStore`, packages/sync carrier.ts): the
// "verified up to here" record of a vault's local log, kept in the vault's PRIVATE LOG database (the
// phone's `log-<vault>.db`, SQLCipher), next to the frames it covers, one row per device. The engine
// writes it only after the frames it covers are committed, and treats it as an optimization it may
// distrust: the text is signed by the device and bound to the vault, the device, the key ring and the
// chain of the log prefix; anything that does not check out is cleared and the whole log replayed.
//
// Same trust boundary as the log itself: whoever can rewrite this database can rewrite the log. The
// signature keeps a write to the database alone from minting a checkpoint; frames that arrive from a
// remote are verified in full whatever this table holds.

import type { SqlDriver } from "../sql/driver.js";

const TABLE = "sync_recovery_checkpoint";

/** One device's checkpoint row in the log database; the table is created on construction. */
export class SqlRecoveryCheckpointStore {
  readonly #driver: SqlDriver;
  readonly #device: string;

  constructor(driver: SqlDriver, device: string) {
    this.#driver = driver;
    this.#device = device;
    driver.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (device TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
    );
  }

  load(): string | undefined {
    const row = this.#driver
      .prepare(`SELECT value FROM ${TABLE} WHERE device = ?`)
      .get<{ value: unknown }>(this.#device);
    return typeof row?.value === "string" ? row.value : undefined;
  }

  save(text: string): void {
    this.#driver
      .prepare(
        `INSERT INTO ${TABLE} (device, value) VALUES (?, ?) ON CONFLICT(device) DO UPDATE SET value = excluded.value`,
      )
      .run(this.#device, text);
  }

  clear(): void {
    this.#driver.prepare(`DELETE FROM ${TABLE} WHERE device = ?`).run(this.#device);
  }
}
