// The private half of one vault on the phone, in its own SQLCipher file `log-<vault>.db` (WAL,
// synchronous FULL): the own-log tables of `SqlLogTransport`, the durable command journal
// (`mobile_attempts`), the key provenance, and the bootstrap row: this device's certificate chain and
// the registry events a pairing welcome seeded (re-ingested at every open; the log replay after it
// is authoritative). Secrets stay in the KeyStore (the identity
// and the keyring); this file holds public facts and sealed frames only. Platform-free over `SqlDriver`
// so the pairing screen, the services and the Node tests share it.

import type { PairedVault } from "@cashu/store/device";
import {
  SqlCommandAttemptJournal,
  type SqlDriver,
  SqlLogTransport,
  SqlProvenanceStore,
} from "@cashu/store/sync";
import { crypto, devices } from "@cashu/sync/engine";
import { z } from "zod";

const BOOTSTRAP_DDL = `CREATE TABLE IF NOT EXISTS vault_bootstrap (
  vault TEXT NOT NULL, device TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
  certificates TEXT NOT NULL, registry_events TEXT NOT NULL
) STRICT`;

/** How this device came to hold the vault: paired from another device, or the on-phone demo. */
export type BootstrapKind = "paired" | "demo";

export interface VaultBootstrap {
  readonly vault: string;
  readonly device: string;
  readonly kind: BootstrapKind;
  /** `pending` while a demo creation runs (an interrupted one is rebuilt), else `ready`. */
  readonly state: "pending" | "ready";
  readonly certificates: readonly Uint8Array[];
  readonly registryEvents: readonly devices.LogEvent[];
}

const HEX = /^[0-9a-f]+$/u;
const rowSchema = z.object({
  vault: z.string(),
  device: z.string(),
  kind: z.enum(["paired", "demo"]),
  state: z.enum(["pending", "ready"]),
  certificates: z.string(),
  registry_events: z.string(),
});

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX.test(hex)) throw new Error("vault_bootstrap_corrupt");
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16),
  );
}

function hasTable(driver: SqlDriver, name: string): boolean {
  return (
    driver.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** The bootstrap row of this log database, or undefined when none was written (a fresh file). */
export function readVaultBootstrap(driver: SqlDriver): VaultBootstrap | undefined {
  if (!hasTable(driver, "vault_bootstrap")) return undefined;
  const rows = driver.prepare("SELECT * FROM vault_bootstrap").all<unknown>();
  if (rows.length === 0) return undefined;
  const row = rows.length === 1 ? rowSchema.safeParse(rows[0]) : undefined;
  if (!row?.success) throw new Error("vault_bootstrap_corrupt");
  const certificates = z.array(z.string()).parse(JSON.parse(row.data.certificates)).map(fromHex);
  const registryEvents = JSON.parse(row.data.registry_events) as devices.LogEvent[];
  if (!Array.isArray(registryEvents)) throw new Error("vault_bootstrap_corrupt");
  return {
    vault: row.data.vault,
    device: row.data.device,
    kind: row.data.kind,
    state: row.data.state,
    certificates,
    registryEvents,
  };
}

/**
 * Create the tables of a fresh log database and its bootstrap row in one transaction: own log,
 * command journal, provenance (bound to `ring`, with `provenance` records) and the bootstrap row.
 *
 * Replacement rule: a `paired` log replaces whatever the file of the same vault held (an earlier
 * pairing of this vault, or the orphan of a pairing that stopped before `pairedVaults` listed it),
 * because the identity and keyring it was bound to have just been replaced in the KeyStore by the new
 * welcome: every table is dropped and created again in the same transaction. A `paired` log also
 * leaves a view-reset mark: the view of that vault may hold an earlier pairing's history, so the next
 * open resets it before anything is replayed (`viewResetPending`, `vaultEngine.ts`).
 * A log that names another vault is refused (`vault_log_mismatch`); a `demo` log never replaces one
 * (`vault_bootstrap_exists`; the services recreate the demo's file instead).
 */
export function createVaultLog(
  driver: SqlDriver,
  input: {
    readonly ring: crypto.Keyring;
    readonly device: string;
    readonly kind: BootstrapKind;
    readonly state: "pending" | "ready";
    readonly certificates: readonly Uint8Array[];
    readonly registryEvents: readonly devices.LogEvent[];
    readonly provenance: (store: SqlProvenanceStore) => void;
    readonly now: () => number;
  },
): void {
  const vault = input.ring.vaultId;
  driver.transaction(() => {
    if (hasTable(driver, "vault_bootstrap")) {
      if (input.kind !== "paired") throw new Error("vault_bootstrap_exists");
      const held = heldVault(driver);
      if (held !== undefined && held !== vault) throw new Error("vault_log_mismatch");
      dropEveryTable(driver);
    }
    new SqlLogTransport({ driver, vault }).ensureSchema();
    SqlCommandAttemptJournal.open(driver, "new", "mobile_attempts", input.now);
    input.provenance(SqlProvenanceStore.open(driver, input.ring, "new"));
    driver.exec(BOOTSTRAP_DDL);
    if (input.kind === "paired") {
      driver.exec(VIEW_RESET_DDL);
      driver.prepare("INSERT INTO view_reset (pending) VALUES (1)").run();
    }
    driver
      .prepare("INSERT INTO vault_bootstrap VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        vault,
        input.device,
        input.kind,
        input.state,
        JSON.stringify(input.certificates.map(toHex)),
        JSON.stringify(input.registryEvents),
      );
  });
}

/** The vault an existing bootstrap row names; undefined when the row is unreadable (same file name). */
function heldVault(driver: SqlDriver): string | undefined {
  const rows = driver.prepare("SELECT vault FROM vault_bootstrap").all<{ vault: unknown }>();
  const named = rows.map((row) => row.vault).filter((v): v is string => typeof v === "string");
  return named.length === 0 ? undefined : named.every((v) => v === named[0]) ? named[0] : "";
}

function dropEveryTable(driver: SqlDriver): void {
  const tables = driver
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  for (const { name } of tables) driver.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
}

const VIEW_RESET_DDL = "CREATE TABLE IF NOT EXISTS view_reset (pending INTEGER NOT NULL) STRICT";

/** The log was (re)created by a pairing: the vault's view must be reset before its next replay. */
export function viewResetPending(driver: SqlDriver): boolean {
  if (!hasTable(driver, "view_reset")) return false;
  return driver.prepare("SELECT 1 FROM view_reset").get() !== undefined;
}

/** The view was reset and replayed from this log: drop the mark. */
export function clearViewReset(driver: SqlDriver): void {
  if (hasTable(driver, "view_reset")) driver.prepare("DELETE FROM view_reset").run();
}

const RELAY_CURSOR_DDL = `CREATE TABLE IF NOT EXISTS relay_cursor (
  seg INTEGER PRIMARY KEY, size INTEGER NOT NULL
) STRICT`;

/**
 * How far this device's own segments are known to be at the relay (segment -> bytes), as the last pass
 * that listed every remote saw them. Own log bytes past it wait to be pushed; it survives a kill, so a
 * launch knows a push is due before any pass ran. Empty for a fresh file (everything is unpushed).
 */
export function readRelayCursor(driver: SqlDriver): ReadonlyMap<number, number> {
  driver.exec(RELAY_CURSOR_DDL);
  const rows = driver
    .prepare("SELECT seg, size FROM relay_cursor")
    .all<{ seg: number; size: number }>();
  return new Map(rows.map((row) => [row.seg, row.size]));
}

/** Own log bytes past `cursor` (a push is due). */
export async function ownUnpushed(
  local: SqlLogTransport,
  vault: string,
  device: string,
  cursor: ReadonlyMap<number, number>,
): Promise<boolean> {
  const segments = await local.list(vault);
  return segments.some((s) => s.device === device && s.size > (cursor.get(s.seg) ?? 0));
}

/**
 * Whether the log of `vault` in `driver` holds own frames of its device the relay is not known to have
 * (false for a fresh file, a log of another vault, which `createVaultLog` refuses anyway, and a log
 * whose bootstrap row does not read).
 */
async function heldUnpushed(driver: SqlDriver, vault: string): Promise<boolean> {
  if (!hasTable(driver, "vault_bootstrap") || heldVault(driver) !== vault) return false;
  let bootstrap: VaultBootstrap | undefined;
  try {
    bootstrap = readVaultBootstrap(driver);
  } catch {
    // An unreadable bootstrap never opens (`vault_bootstrap_corrupt`), so nothing in it could be
    // pushed either: re-pairing is the repair.
    return false;
  }
  if (bootstrap === undefined) return false;
  const local = new SqlLogTransport({ driver, vault });
  return ownUnpushed(local, vault, bootstrap.device, readRelayCursor(driver));
}

/** Replace the relay cursor (one transaction). */
export function saveRelayCursor(driver: SqlDriver, cursor: ReadonlyMap<number, number>): void {
  driver.transaction(() => {
    driver.exec(RELAY_CURSOR_DDL);
    driver.prepare("DELETE FROM relay_cursor").run();
    const insert = driver.prepare("INSERT INTO relay_cursor (seg, size) VALUES (?, ?)");
    for (const [seg, size] of cursor) insert.run(seg, size);
  });
}

const PAIRED_ENTRY_DDL = "CREATE TABLE IF NOT EXISTS paired_entry (entry TEXT NOT NULL) STRICT";

/**
 * Keep a copy of this vault's `pairedVaults` entry in its own log (written before the device store's,
 * `addPairedVault`, and refreshed at boot): the device store is one file, and when it has to be
 * recreated (a torn first page) the list of paired vaults is rebuilt from these copies
 * (`restorePairedVaults`) instead of the phone silently forgetting its vaults. Public facts only.
 */
export function savePairedEntry(driver: SqlDriver, entry: PairedVault): void {
  driver.transaction(() => {
    driver.exec(PAIRED_ENTRY_DDL);
    driver.prepare("DELETE FROM paired_entry").run();
    driver.prepare("INSERT INTO paired_entry (entry) VALUES (?)").run(JSON.stringify(entry));
  });
}

/**
 * The entry copy of this log, undecoded (the device store's command validates it); undefined when
 * none was written (a log whose pairing never reached `addPairedVault`). Throws
 * `paired_entry_corrupt` when a copy exists but does not parse.
 */
export function readPairedEntry(driver: SqlDriver): unknown {
  if (!hasTable(driver, "paired_entry")) return undefined;
  const rows = driver.prepare("SELECT entry FROM paired_entry").all<{ entry: unknown }>();
  if (rows.length === 0) return undefined;
  const raw = rows.length === 1 ? rows[0]?.entry : undefined;
  if (typeof raw !== "string") throw new Error("paired_entry_corrupt");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("paired_entry_corrupt");
  }
}

/** What `restorePairedVaults` reads and writes (the phone's files and device store; fakes in tests). */
export interface PairedRestorePorts {
  /** The vaults with a `log-<id>.db` that is not a demo vault's. */
  readonly vaults: readonly string[];
  /** Open one vault's log (throws when the key does not open it). */
  openLog(vault: string): SqlDriver;
  /** Add the entry to the device store's list; false when the store refuses it. */
  save(entry: unknown): boolean;
}

/**
 * Rebuild the list of paired vaults from the entry copies in their logs (the device store's list read
 * empty: recreated after a torn file, or a kill between the copy and the list in `addPairedVault`).
 * A log without a copy is the unlisted file of a pairing that never finished: skipped. `unreadable`
 * counts the logs that may belong to a paired vault but could not be restored (the log does not open,
 * its copy does not parse or names another vault, the store refused it): while any remain, the phone
 * must not fall back to the demo.
 */
export function restorePairedVaults(ports: PairedRestorePorts): {
  readonly restored: number;
  readonly unreadable: number;
} {
  let restored = 0;
  let unreadable = 0;
  for (const vault of ports.vaults) {
    let entry: unknown;
    try {
      const log = ports.openLog(vault);
      try {
        entry = readPairedEntry(log);
      } finally {
        log.close();
      }
    } catch {
      unreadable++;
      continue;
    }
    if (entry === undefined) continue;
    const named =
      typeof entry === "object" && entry !== null
        ? (entry as { vaultId?: unknown }).vaultId
        : undefined;
    if (named === vault && ports.save(entry)) restored++;
    else unreadable++;
  }
  return { restored, unreadable };
}

/** Mark a pending (demo) bootstrap complete. */
export function markVaultLogReady(driver: SqlDriver): void {
  driver.prepare("UPDATE vault_bootstrap SET state = 'ready'").run();
}

/** Mark a demo bootstrap pending again: the next launch builds that demo vault from scratch. */
export function markVaultLogPending(driver: SqlDriver): void {
  driver.prepare("UPDATE vault_bootstrap SET state = 'pending'").run();
}

/** What a pairing welcome leaves for the phone to keep (`devices.JoinerWelcome` plus this device). */
export interface JoinedVault {
  readonly identity: crypto.DeviceIdentity;
  readonly ring: crypto.Keyring;
  /** This device's certificate from the welcome. */
  readonly certificate: Uint8Array;
  readonly registryEvents: readonly devices.LogEvent[];
  /** The inviter's device id (the sender of every key the welcome carried). */
  readonly inviter: string;
}

/**
 * The bootstrap chain of a joined device: the certificates carried by the welcome's `device.added`
 * events (the inviter's chain back to the recovery key; the joiner verified those events against the
 * SAS-authenticated welcome) and this device's own certificate last. `loadDeviceAuthority` checks the
 * chain to the recovery key again at every open.
 */
function joinedCertificates(
  registryEvents: readonly devices.LogEvent[],
  own: Uint8Array,
): Uint8Array[] {
  const chain: Uint8Array[] = [];
  for (const event of registryEvents) {
    const certificate = event.data.certificate;
    if (event.type === devices.DEVICE_ADDED && typeof certificate === "string") {
      chain.push(fromHex(certificate));
    }
  }
  return [...chain, own.slice()];
}

/**
 * Keep a pairing welcome on the phone: the identity and the keyring into the KeyStore, then the
 * vault's log database (`driver`) with the certificate, the registry seed and the pairing provenance
 * of every key. The caller adds the `pairedVaults` entry after this resolved (`addPairedVault`).
 *
 * Safe to run twice: a retry after a crash, or a re-pairing of a vault this phone already holds,
 * replaces the log (`createVaultLog`'s replacement rule), unless the old log holds own frames the relay
 * is not known to have: then nothing is replaced and it throws `unpushed_changes` (the pairing screen
 * runs a pass of the open vault and tries again, or tells the user); a crash between this and `addPairedVault`
 * leaves an unlisted file that the next pairing of the same vault replaces. `discardUnpushed` skips the
 * check (the owner agreed to lose them). One device id has one
 * identity (the KeyStore slot is per id): a phone that pairs a second vault under the same device id
 * passes the identity it already holds. A vault whose session is open is closed first
 * (`services.vaults.get(vault)?.close()`), so no engine writes into the file being replaced.
 */
export async function storeJoinedVault(
  keyStore: crypto.KeyStore,
  driver: SqlDriver,
  joined: JoinedVault,
  now: () => number,
  options: { readonly discardUnpushed?: boolean } = {},
): Promise<void> {
  // Re-pairing replaces the log: own frames the relay never got would go with it (and with the keyring
  // they are sealed under). Refused before anything is replaced; a pass pushes them first. A vault the
  // relay no longer takes frames for (this phone was removed) can never push them: the owner's explicit
  // "remove them and pair" (`discardUnpushed`) is the only way past.
  if (!options.discardUnpushed && (await heldUnpushed(driver, joined.ring.vaultId))) {
    throw new Error("unpushed_changes");
  }
  await crypto.saveDeviceIdentity(keyStore, joined.identity);
  await crypto.saveKeyring(keyStore, joined.ring);
  createVaultLog(driver, {
    ring: joined.ring,
    device: joined.identity.deviceId,
    kind: "paired",
    state: "ready",
    certificates: joinedCertificates(joined.registryEvents, joined.certificate),
    registryEvents: joined.registryEvents,
    provenance: (store) =>
      devices.recordPairingProvenance(store, joined.ring, joined.inviter, now()),
    now,
  });
}

/** What `storeJoinedInQueue` needs of the running services. */
export interface JoinedStorePorts {
  /** The vault queue every command and pass of the vault runs through. */
  readonly queue: { run<T>(vault: string, task: () => Promise<T>): Promise<T> };
  /** The open session of the vault (a re-pairing), closed before anything is checked or replaced. */
  readonly session: { close(): Promise<void> } | undefined;
  readonly keyStore: crypto.KeyStore;
  readonly driver: SqlDriver;
  readonly now: () => number;
}

/**
 * `storeJoinedVault` as the services run it: the vault's open session (a re-pairing of a vault this
 * phone holds) is closed first, then the unpushed check and the replacement run as ONE task of the
 * vault's queue, so no command of that session can append between the check and the drop.
 */
export async function storeJoinedInQueue(
  ports: JoinedStorePorts,
  joined: JoinedVault,
  options: { readonly discardUnpushed?: boolean } = {},
): Promise<void> {
  await ports.session?.close();
  await ports.queue.run(joined.ring.vaultId, () =>
    storeJoinedVault(ports.keyStore, ports.driver, joined, ports.now, options),
  );
}

/** The steps of forgetting one paired vault, each one IO the services provide. */
export interface ForgetVaultPorts {
  /** Delete `log-<vault>.db` (it holds the copy of the list entry). */
  deleteLog(): void;
  /** Delete `vault-<vault>.db`. */
  deleteView(): void;
  /** Drop the `pairedVaults` entry; false when the device store refused. */
  forgetEntry(): boolean;
  /** Delete the vault's keyring and this device's identity in it from the KeyStore. */
  deleteKeys(): Promise<void>;
}

/**
 * Forget one paired vault (the removed state's "remove this copy"). The log goes FIRST: it holds the
 * copy of the list entry (`savePairedEntry`), and an empty list is rebuilt from those copies at the next
 * launch (`restorePairedVaults`), so a kill after the list entry but before the log would bring the
 * vault back. Then the view, the entry, the keys (a kill before the keys leaves sealed values nothing
 * names; the phone wipe removes them).
 */
export async function forgetVault(ports: ForgetVaultPorts): Promise<void> {
  ports.deleteLog();
  ports.deleteView();
  if (!ports.forgetEntry()) throw new Error("paired_vaults_corrupt");
  await ports.deleteKeys();
}
