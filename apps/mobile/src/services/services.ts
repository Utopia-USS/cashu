// The app's stable services, built once at startup: the device store, one view store per vault
// (in-process, sync SQLite encrypted with the device key) behind @cashu/store-react's synchronous
// client, each vault's sync session (its private log database, the engine and the durable command
// boundary, `vaultEngine.ts`), the sync triggers' runner, the device-local price cache, the read-only
// money queries and the crypto self-test. Rebuilt by `resetServices` (the phone wipe) and
// `reopenServices` (a vault paired or forgotten), which the root follows by remounting its tree.
//
// Which vaults: the paired ones (`pairedVaults` in the device store) when there is any, else the
// companion demo (two synthetic vaults built on the phone, local only). A paired vault's view needs its
// gid salt, which lives in its keyring in the KeyStore (asynchronous), so a phone with paired vaults
// first runs `prepareServices` (the root shows the "opening" phase meanwhile) and then builds the
// services synchronously. Every vault's engine opens in the background after that; a command sent
// before it is open waits for it in the vault's queue.

import type { ProfileRole } from "@cashu/domain/core/notifications";
import { enabledModules, profileIdentity } from "@cashu/store/core/profile";
import {
  currentVault,
  type DeviceStore,
  forgetPairedVault,
  type PairedVault,
  pairedVaults,
  savePairedVault,
  setAlertMarked,
  setCurrentVault,
  setNotificationPrefs,
} from "@cashu/store/device";
import { type VaultSalt, vaultSalt } from "@cashu/store/gid";
import type { SqlPriceCache } from "@cashu/store/investments/local";
import type { Store } from "@cashu/store/runtime";
import { initializeMetaClockGuard, type SqlDriver } from "@cashu/store/sync";
import type { StoreClient } from "@cashu/store-react";
import { createSyncClient, type DurableVaultHandle } from "@cashu/store-react/local";
import {
  AnonymousAuth,
  crypto,
  FirestoreRest,
  FirestoreTransport,
  type Transport,
} from "@cashu/sync/engine";
import {
  buildCompanionVault,
  COMPANION_VAULTS,
  type CompanionBuild,
  companionVaultComplete,
  seedCompanionDemoPrices,
} from "../fixture/companionDemo";
import { companionMarkedAlert } from "../fixture/companionInvestments";
import { appendBenchLog, deleteBenchLogs } from "../platform/benchLog";
import {
  createMobileKeyStore,
  deleteKeyStoreFiles,
  deleteKeyStoreKek,
  deletePhoneSecrets,
  discardWithoutDbKey,
  keyStoreFilesExist,
} from "../platform/keystore";
import { deleteLanguagePin } from "../platform/language";
import { localAuthenticator } from "../platform/localAuth";
import { keyStoreAuthStore } from "../platform/relayAuthStore";
import { relayConfig } from "../platform/relayConfig";
import { nativeLibsodium, nativeSignLibsodium } from "../platform/sodium";
import {
  databaseFiles,
  deleteDatabaseFile,
  deleteDatabaseFiles,
  openDeviceStore,
  openPriceCache,
  openVaultLog,
  openVaultStore,
  phoneDbKey,
  recreateVaultLog,
  recreateVaultStore,
  storageInfo,
} from "../platform/sqlite";
import {
  isDbKeyMismatch,
  MARKET_DB,
  openBaseFiles,
  openVaultFiles,
  vaultOfFile,
} from "../platform/sqliteKeying";
import { localToday } from "../screens/screenContext";
import { type CryptoSelfTest, runCryptoSelfTest } from "../selftest/cryptoSelfTest";
import type { Authenticator } from "../shell/auth";
import { createSyncRunner, type SyncRunner } from "../sync/syncRunner";
import { createVaultQueue } from "./commandQueue";
import { isDemoVault } from "./demo";
import { SCAFFOLD_DEVICE } from "./device";
import { phoneInvestmentSources } from "./investments";
import { bumpEpoch, servicesCloser, showOpening, showWiping } from "./lifecycle";
import { createMoneyQueries, type MoneyQueries } from "./moneyQueries";
import {
  forgetVault,
  type JoinedVault,
  readPairedEntry,
  readVaultBootstrap,
  restorePairedVaults,
  savePairedEntry,
  storeJoinedInQueue,
} from "./vaultBootstrap";
import { createVaultSession, type VaultSession, type VaultSyncStatus } from "./vaultEngine";
import { beforeWipeTasks, onBeforeWipe, wipeDevice } from "./wipe";

interface ServicesProfile {
  readonly vault: string;
  readonly slug: string;
  readonly name: string;
  /** Enabled module ids at boot (`enabledModules`): the profile sheet captions the profiles it does not show. */
  readonly modules: readonly string[];
  readonly role: ProfileRole;
}

/** The at-rest encryption of this launch's databases (the debug screen's storage line). */
interface StorageInfo {
  /** SQLCipher's version; null when the files are not encrypted. */
  readonly cipherVersion: string | null;
}

/** A paired vault this launch could not open: no session, store or profile (the pairing screens list it). */
interface UnavailableVault {
  readonly vault: string;
  /** Its name as `pairedVaults` last knew it. */
  readonly name: string;
  /**
   * Why, value-free: `needs_repair` (its files do not open under the key; nothing was deleted) or the
   * keyring's code (`keyring_unreadable`, `vault_keyring_missing`, `keystore_*`).
   */
  readonly failure: string;
}

/** This phone's vault sessions, one per vault the client holds. */
interface PhoneVaults {
  get(vault: string): VaultSession | undefined;
  list(): readonly VaultSession[];
  /** The status of a paired vault this launch could not open: `failed` with its code (stable object). */
  unavailable(vault: string): VaultSyncStatus | undefined;
  /** Every paired vault this launch could not open, in pairing order. */
  unavailableVaults(): readonly UnavailableVault[];
}

export interface Services {
  /** The store client of every screen (`StoreProvider`). */
  readonly client: StoreClient;
  /** This device's own store (current profile, device settings; never synced). */
  readonly device: DeviceStore;
  /** Vault queries over this device's price cache and the phone's investments sources. */
  readonly moneyQueries: MoneyQueries;
  /** The current default vault's store, for the debug screen's engine-level status and rebuild. */
  readonly store: Store;
  /** The store of one of this device's vaults; throws for a vault the device does not hold. */
  readonly storeOf: (vault: string) => Store;
  /** This device's profiles (one per vault), read at boot. */
  readonly profiles: readonly ServicesProfile[];
  /** Each vault's sync session: status, engine, passes. */
  readonly vaults: PhoneVaults;
  /** The sync triggers' runner (`PhoneSync`, the background task). */
  readonly sync: SyncRunner;
  /** This device's market price cache (prices and FX rates; device-local, never synced). */
  readonly prices: SqlPriceCache;
  /** Store open time (ms, every vault), including the integrity check after an unclean session. */
  readonly openMs: number;
  /** The fixture builds of this launch, one per vault built (empty when every vault was reopened). */
  readonly firstLoad: readonly CompanionBuild[];
  /** Runs after the first frame; the crypto panel suspends on it. */
  readonly cryptoSelfTest: Promise<CryptoSelfTest>;
  readonly storage: StorageInfo;
  /** Face ID / Touch ID / passcode for the app lock. */
  readonly auth: Authenticator;
  /**
   * Every vault on this phone is a demo vault: the app lock defaults to off. TRANSITIONAL(S44): a
   * paired phone holds real vaults and the lock defaults to on.
   */
  readonly isDemo: boolean;
  /** Close every engine after its queued work (before `close` when the caller can wait). */
  closeSessions(): Promise<void>;
  /** Close every database (client, vaults, logs, price cache, device store); a second call does nothing. */
  close(): void;
}

// TRANSITIONAL(S44): the demo's roles; a paired phone's role comes from its `pairedVaults` entry.
const COMPANION_ROLES: Readonly<Record<"anna" | "home", ProfileRole>> = {
  anna: "owner",
  home: "partner",
};

let services: Services | undefined;

/**
 * Why the root is in its fatal state, value-free (`no_vault`, `paired_vaults_unlisted`, a wipe step's
 * code, ...): the root shows re-pair copy for the codes a pairing repairs. Undefined while not failed.
 */
let servicesFailure: string | undefined;

/** The code of the last services failure that put the root in its fatal state. */
export function lastServicesFailure(): string | undefined {
  return servicesFailure;
}

const now = () => performance.now();

/**
 * This launch's sodium (the native library, the AEAD from @noble), built on first use. Building it also
 * binds the native Ed25519 verification (`crypto.libsodiumEd25519Verifier`: the same answers as @noble,
 * natively, so a vault open does not verify every frame head in pure JS); a library that fails its
 * known answers leaves @noble bound (correct, only slower; the crypto self-test reports `nativeVerify`).
 */
let sodiumInstance: crypto.Sodium | undefined;
export function phoneSodium(): crypto.Sodium {
  if (sodiumInstance === undefined) {
    sodiumInstance = crypto.fromLibsodium(nativeLibsodium, { aead: "noble" });
    try {
      crypto.bindEd25519Verifier(crypto.libsodiumEd25519Verifier(nativeSignLibsodium));
    } catch {
      // Keeps @noble.
    }
  }
  return sodiumInstance;
}

/**
 * This launch's KeyStore, one instance for every reader and writer (the paired vaults' salts, the
 * sessions, the relay identity, the crypto self-test): its key-encryption key is created single-flight
 * per instance, so two instances could each create one on a fresh install. Dropped by the wipe, whose
 * new key-encryption key the next instance creates.
 */
let keyStoreInstance: crypto.KeyStore | undefined;
function phoneKeyStore(): crypto.KeyStore {
  keyStoreInstance ??= createMobileKeyStore(phoneSodium());
  return keyStoreInstance;
}

/**
 * Database files and sealed values without the device key cannot be read, so they are deleted before
 * the key is created: the leftovers of an interrupted wipe (which deletes the key first), with the
 * KeyStore's key-encryption key (`discardWithoutDbKey`). Returns that key's delete, which the prepare
 * awaits before the KeyStore is used. The plaintext files of a demo install from before encryption land
 * here too, once (TRANSITIONAL(S44): a paired phone creates encrypted files from day one).
 */
function discardFilesWithoutKey(): Promise<void> | undefined {
  const left = discardWithoutDbKey({
    dbKeyExists: () => phoneDbKey.exists(),
    databaseFiles,
    deleteDatabaseFiles: () => void deleteDatabaseFiles(),
    keyStoreFilesExist,
    deleteKeyStoreFiles,
    deleteKek: deleteKeyStoreKek,
  });
  if (left === undefined) return undefined;
  // A cached KEK would outlive its delete: the next KeyStore reads (or creates) the key afresh.
  keyStoreInstance = undefined;
  appendBenchLog({
    kind: "storage_reset",
    reason: "interrupted_wipe",
    files: left.databaseFiles,
    keys: left.keyStoreFiles,
  });
  // Nothing sealed is left for a surviving KEK to open: a failed delete is logged, not fatal.
  return left.kek.catch((error: unknown) => {
    appendBenchLog({ kind: "storage_reset", reason: "kek_delete_failed", error });
  });
}

/** The device-wide databases, opened first (the vault list lives in the device store). */
interface Base {
  readonly key: string;
  readonly device: DeviceStore;
  readonly prices: SqlPriceCache;
  readonly openMs: number;
}

/** What `prepareServices` leaves for `bootServices`: the base and every paired vault's gid salt. */
interface Prepared {
  readonly base: Base;
  readonly paired: readonly PairedVault[];
  readonly salts: ReadonlyMap<string, VaultSalt>;
  /** Paired vaults whose keyring did not read this launch, with a value-free code (`unavailable`). */
  readonly unreadable: ReadonlyMap<string, string>;
  /**
   * The list of paired vaults is empty, yet vault files on the phone may belong to paired vaults that
   * could not be restored (`restorePairedVaults`): the demo must not take their place.
   */
  readonly unlisted: boolean;
}

let prepared: Prepared | undefined;
let preparing: Promise<void> | undefined;

/** Open `file` under `key` and close it again: false only when the key does not open it. */
function keyOpens(file: string, key: string): boolean {
  try {
    if (file === MARKET_DB) {
      openPriceCache(key).close();
      return true;
    }
    const vault = vaultOfFile(file);
    // A view needs its salt to open; the vault's log tells the same about the key.
    if (vault === undefined || !file.startsWith("log-")) return false;
    openVaultLog(vault, key).close();
    return true;
  } catch (error) {
    // Any failure but a mismatch got past the key check: the key opens the file.
    return !isDbKeyMismatch(error);
  }
}

/**
 * Open the device store and the price cache under the device key (created when missing, after
 * `discardFilesWithoutKey`), a key mismatch handled per file
 * (`openBaseFiles`). TRANSITIONAL(S44): a key that opens no file rebuilds the demo; a paired phone's
 * vault files stay for a re-pairing.
 */
function openBase(): Base {
  const key = phoneDbKey.loadOrCreate();
  const t0 = now();
  const { device, prices } = openBaseFiles({
    openDevice: () => openDeviceStore(key),
    openPrices: () => openPriceCache(key),
    files: databaseFiles,
    opens: (file) => keyOpens(file, key),
    remove: deleteDatabaseFile,
    isDemo: isDemoVault,
    report: (reason, files) => appendBenchLog({ kind: "storage_reset", reason, files }),
  });
  return { key, device, prices, openMs: now() - t0 };
}

function pairedOf(device: DeviceStore): readonly PairedVault[] {
  return pairedVaults.run((sql, ...p) => device.read(sql, ...p), undefined);
}

/**
 * The paired vaults of this phone. An empty list while vault logs of paired vaults are on disk (the
 * device store was recreated, or a kill between the log's entry copy and the list) is rebuilt from
 * those logs' copies (`restorePairedVaults`); `unlisted` when files remain that might be paired
 * vaults but could not be restored.
 */
function pairedOrRestored(base: Base): { paired: readonly PairedVault[]; unlisted: boolean } {
  const listed = pairedOf(base.device);
  if (listed.length > 0) return { paired: listed, unlisted: false };
  const vaults = databaseFiles().flatMap((file) => {
    const vault = file.startsWith("log-") ? vaultOfFile(file) : undefined;
    return vault === undefined || isDemoVault(vault) ? [] : [vault];
  });
  if (vaults.length === 0) return { paired: listed, unlisted: false };
  const { restored, unreadable } = restorePairedVaults({
    vaults,
    openLog: (vault) => openVaultLog(vault, base.key),
    save: (entry) => base.device.run(savePairedVault, entry as PairedVault).ok,
  });
  appendBenchLog({ kind: "paired_restore", restored, unreadable });
  const paired = pairedOf(base.device);
  return { paired, unlisted: paired.length === 0 && unreadable > 0 };
}

/**
 * The asynchronous first phase: open the device store and read each paired vault's gid salt from its
 * keyring. Returns undefined when it finished synchronously (no paired vault: the demo needs no key);
 * a vault whose keyring cannot be read is left out of this launch (a bench line says so).
 */
function prepareServices(): Promise<void> | undefined {
  if (prepared !== undefined) return undefined;
  if (preparing !== undefined) return preparing;
  const leftoverKek = discardFilesWithoutKey();
  const base = openBase();
  const { paired, unlisted } = pairedOrRestored(base);
  if (paired.length === 0 && leftoverKek === undefined) {
    prepared = { base, paired, salts: new Map(), unreadable: new Map(), unlisted };
    return undefined;
  }
  preparing = (async () => {
    // An interrupted wipe's key-encryption key goes before anything reads or seals with the KeyStore.
    await leftoverKek;
    if (paired.length === 0) {
      prepared = { base, paired, salts: new Map(), unreadable: new Map(), unlisted };
      return;
    }
    const keyStore = phoneKeyStore();
    const salts = new Map<string, VaultSalt>();
    const unreadable = new Map<string, string>();
    for (const entry of paired) {
      try {
        const ring = await crypto.loadKeyring(keyStore, phoneSodium(), entry.vaultId);
        if (ring === null) throw new Error("vault_keyring_missing");
        const salt = ring.gidSalt();
        salts.set(entry.vaultId, vaultSalt(salt.expose().slice()));
        salt.wipe();
        ring.wipe();
      } catch (error) {
        // `keyring_unreadable` unless the KeyStore named it (a value-free code either way).
        const code = codeOf(error) === "unknown" ? "keyring_unreadable" : codeOf(error);
        unreadable.set(entry.vaultId, code);
        appendBenchLog({ kind: "vault_unavailable", reason: code });
      }
    }
    prepared = { base, paired, salts, unreadable, unlisted: false };
  })().finally(() => {
    preparing = undefined;
  });
  return preparing;
}

/** Prepare (when needed) and build the services: the background task's way in. */
export async function servicesReady(): Promise<Services> {
  await prepareServices();
  return bootServices();
}

/**
 * The root's start: build the services before the first render when that is synchronous (the demo;
 * the native splash covers its first-launch fixture build), else show the opening phase until the
 * paired vaults' keys are read.
 */
export function startServices(): void {
  let pending: Promise<void> | undefined;
  try {
    pending = prepareServices();
    if (pending === undefined) {
      bootServices();
      return;
    }
  } catch (error) {
    // No vault to show (`paired_vaults_unlisted`, `no_vault`): the fatal state instead of a crash.
    servicesFailure = codeOf(error);
    appendBenchLog({ kind: "services_failed", reason: servicesFailure });
    bumpEpoch("failed");
    return;
  }
  showOpening();
  pending
    .then(() => {
      bootServices();
      bumpEpoch("ready");
    })
    .catch((error: unknown) => {
      // No usable vault (every paired vault's keys unreadable): the fatal "open it again" state.
      servicesFailure = codeOf(error);
      appendBenchLog({ kind: "services_failed", reason: servicesFailure });
      bumpEpoch("failed");
    });
}

/** One vault's open databases and how it was set up this launch. */
interface OpenedVault {
  readonly vault: string;
  readonly device: string;
  readonly kind: "paired" | "demo";
  readonly store: Store;
  readonly log: SqlDriver;
  readonly name: string;
  readonly role: ProfileRole;
}

/**
 * The demo vaults, each with a finished fixture build and a ready log; a vault without both (first
 * launch, a build or an engine setup that stopped halfway, a demo from before the engine) is built
 * again into fresh files: a half-built demo is never kept.
 */
function openDemoVaults(key: string, firstLoad: CompanionBuild[]): OpenedVault[] {
  const today = localToday();
  const opened: OpenedVault[] = [];
  try {
    for (const which of ["anna", "home"] as const) {
      const spec = COMPANION_VAULTS[which];
      const files = openVaultFiles(
        "demo",
        () => openVaultPair(spec.vault, spec.salt, key),
        () => {
          deleteDatabaseFile(`vault-${spec.vault}.db`);
          deleteDatabaseFile(`log-${spec.vault}.db`);
          appendBenchLog({ kind: "storage_reset", reason: "demo_key_mismatch", files: 2 });
        },
      );
      if (files.kind !== "opened") throw new Error("demo_unavailable");
      let { store, log } = files.value;
      let ready = false;
      try {
        ready = readVaultBootstrap(log)?.state === "ready";
      } catch {
        ready = false;
      }
      if (!ready || !companionVaultComplete(store, which)) {
        store = recreateVaultStore(store, spec.vault, spec.salt, key);
        log = recreateVaultLog(log, spec.vault, key);
        // The guard is seeded on the empty view, before the fixture's first event.
        initializeMetaClockGuard(store.driver, SCAFFOLD_DEVICE);
        const build = buildCompanionVault(store, which, today, now);
        firstLoad.push(build);
        appendBenchLog({ kind: "fixture", ...build });
      }
      opened.push({
        vault: spec.vault,
        device: SCAFFOLD_DEVICE,
        kind: "demo",
        store,
        log,
        name: spec.name,
        role: COMPANION_ROLES[which],
      });
    }
    return opened;
  } catch (error) {
    closeOpened(opened);
    throw error;
  }
}

/** One vault's view and log; the view is closed again when the log does not open. */
function openVaultPair(
  vault: string,
  salt: VaultSalt,
  key: string,
): { store: Store; log: SqlDriver } {
  const store = openVaultStore(vault, salt, key);
  try {
    return { store, log: openVaultLog(vault, key) };
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * The paired vaults with readable keys. A vault whose view or log the key does not open keeps its
 * files and is reported in `needsRepair` (its status reads `failed` / `needs_repair`), never deleted.
 */
function openPairedVaults(prepared: Prepared, needsRepair: Set<string>): OpenedVault[] {
  const opened: OpenedVault[] = [];
  try {
    for (const entry of prepared.paired) {
      const salt = prepared.salts.get(entry.vaultId);
      if (salt === undefined) continue;
      const files = openVaultFiles(
        "paired",
        () => openVaultPair(entry.vaultId, salt, prepared.base.key),
        () => undefined,
      );
      if (files.kind === "needs_repair") {
        needsRepair.add(entry.vaultId);
        appendBenchLog({ kind: "vault_unavailable", reason: "needs_repair" });
        continue;
      }
      const { store, log } = files.value;
      opened.push({
        vault: entry.vaultId,
        device: entry.deviceId,
        kind: "paired",
        store,
        log,
        name: entry.name,
        role: entry.role,
      });
    }
    return opened;
  } catch (error) {
    closeOpened(opened);
    throw error;
  }
}

function closeOpened(opened: readonly OpenedVault[]): void {
  for (const v of opened) {
    try {
      v.store.close();
    } catch {
      // The open failure is the one to report.
    }
    try {
      v.log.close();
    } catch {
      // Same.
    }
  }
}

/** This build's relay client: one anonymous identity for the pairing and every paired vault's transport. */
interface PhoneRelay {
  readonly projectId: string;
  readonly rest: FirestoreRest;
  uid(): Promise<string>;
}

/** Built once per KeyStore instance (the wipe drops both): two clients would race the first sign-up. */
let relayInstance: { readonly keyStore: crypto.KeyStore; readonly relay: PhoneRelay } | undefined;

/** This build's relay client, or undefined without a sync config (every relay surface stays off). */
export function phoneRelay(): PhoneRelay | undefined {
  const config = relayConfig();
  if (config === undefined) return undefined;
  const keyStore = phoneKeyStore();
  if (relayInstance?.keyStore !== keyStore) {
    const auth = new AnonymousAuth({
      endpoint: { apiKey: config.apiKey },
      store: keyStoreAuthStore(keyStore),
    });
    const rest = new FirestoreRest({ endpoint: { projectId: config.projectId }, auth });
    relayInstance = {
      keyStore,
      relay: { projectId: config.projectId, rest, uid: () => auth.uid() },
    };
  }
  return relayInstance.relay;
}

/** The relay transport of this build (one per phone, every paired vault), or none without a config. */
function relayRemote(): FirestoreTransport | undefined {
  const relay = phoneRelay();
  if (relay === undefined) return undefined;
  return new FirestoreTransport({ rest: relay.rest, uid: () => relay.uid() });
}

/** What the pairing needs of the running services besides their public face (set by `bootServices`). */
interface ServicesInternals {
  readonly queue: ReturnType<typeof createVaultQueue>;
  /** Each opened vault's log database. */
  readonly logs: ReadonlyMap<string, SqlDriver>;
}
let internals: ServicesInternals | undefined;

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Write the log's copy of its `pairedVaults` entry when it differs (backfills logs from before it). */
function keepPairedEntry(log: SqlDriver, entry: PairedVault): void {
  try {
    if (JSON.stringify(readPairedEntry(log)) === JSON.stringify(entry)) return;
  } catch {
    // An unreadable copy is replaced.
  }
  savePairedEntry(log, entry);
}

export function bootServices(): Services {
  if (services) return services;
  if (prepared === undefined && prepareServices() !== undefined) {
    // Paired vaults need their keys first (`startServices`, `servicesReady`).
    throw new Error("services_not_prepared");
  }
  const ready = prepared as Prepared;
  // Files of paired vaults the list lost and could not restore: never the demo in their place.
  if (ready.unlisted) throw new Error("paired_vaults_unlisted");
  const { key, device, prices } = ready.base;
  const firstLoad: CompanionBuild[] = [];
  const t0 = now();
  const needsRepair = new Set<string>();
  const opened =
    ready.paired.length > 0 ? openPairedVaults(ready, needsRepair) : openDemoVaults(key, firstLoad);
  const openMs = ready.base.openMs + (now() - t0);
  const fallback = opened[0]?.vault ?? null;
  const missing = new Map<string, string>([
    ...[...needsRepair].map((vault) => [vault, "needs_repair"] as const),
    ...ready.unreadable,
  ]);
  // Unset, or a vault this device no longer holds (the S41 scaffold's demo vault): the first one. A
  // paired vault that merely did not open this launch stays the user's choice for the next one.
  const current = currentVault.run((sql, ...p) => device.read(sql, ...p), undefined);
  if (current === null || (!opened.some((v) => v.vault === current) && !missing.has(current))) {
    device.run(setCurrentVault, { vault: fallback });
  }
  const keyStore = phoneKeyStore();
  const relay = opened.some((v) => v.kind === "paired") ? relayRemote() : undefined;
  const queue = createVaultQueue();
  const sessions = new Map<string, VaultSession>(
    opened.map((v) => {
      const remotes: Transport[] = v.kind === "paired" && relay !== undefined ? [relay] : [];
      return [
        v.vault,
        createVaultSession({
          vault: v.vault,
          device: v.device,
          kind: v.kind,
          store: v.store,
          log: v.log,
          keyStore,
          sodium: phoneSodium(),
          remotes,
          ...(relay !== undefined && remotes.length > 0
            ? { relayStatus: () => relay.status() }
            : {}),
          queue,
          now: () => Date.now(),
          yieldToUi: nextFrame,
        }),
      ];
    }),
  );
  const handles = new Map<string, DurableVaultHandle>(
    [...sessions.values()].map((s) => [
      s.vault,
      {
        store: s.store,
        execute: (command, input, attemptKey) => s.execute(command, input, attemptKey),
        reconcile: (attemptKey) => s.reconcile(attemptKey),
      },
    ]),
  );
  const client = createSyncClient({ device, vaults: handles });
  const identities = new Map(
    opened.map((v) => [v.vault, profileIdentity.run(v.store.read.bind(v.store), undefined)]),
  );
  const profiles = opened.map((v) => {
    const identity = identities.get(v.vault) ?? null;
    return {
      vault: v.vault,
      // Before the first sync a paired vault has no profile yet: its stored name ("New profile").
      slug: identity?.slug ?? v.vault,
      name: identity?.name ?? v.name,
      modules: identity === null ? [] : enabledModules.run(v.store.read.bind(v.store), undefined),
      role: v.role,
    };
  });
  // A paired vault's stored name follows its profile once that arrived (the pairing list, the sheet);
  // its log keeps a copy of the entry (`savePairedEntry`), written before the list.
  for (const entry of ready.paired) {
    const name = identities.get(entry.vaultId)?.name;
    const next =
      name !== undefined && name !== entry.name ? { ...entry, name: name.slice(0, 200) } : entry;
    const log = opened.find((v) => v.vault === entry.vaultId)?.log;
    if (log !== undefined) keepPairedEntry(log, next);
    if (next !== entry) device.run(savePairedVault, next);
  }
  const storeOf = (vault: string): Store => {
    const session = sessions.get(vault);
    if (session === undefined) throw new Error(`no store for vault ${vault} on this device`);
    return session.store;
  };
  const anna = COMPANION_VAULTS.anna.vault;
  // TRANSITIONAL(S44): a freshly built Anna comes with her demo prices (the phone's own refresh skips
  // the demo vaults, so they stay) and follows her CD Projekt alert on this phone ("tell my phone").
  if (firstLoad.some((b) => b.vault === anna)) {
    seedCompanionDemoPrices(prices, localToday());
    const annaStore = storeOf(anna);
    const alert = companionMarkedAlert(annaStore.read.bind(annaStore), new Date().toISOString());
    if (alert !== null) {
      device.run(setAlertMarked, { vault: anna, alert, marked: true });
      device.run(setNotificationPrefs, { vault: anna, prefs: { alertsFired: true } });
    }
  }
  const cryptoSelfTest = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
    runCryptoSelfTest({
      lib: nativeLibsodium,
      signLib: nativeSignLibsodium,
      keyStore: phoneKeyStore,
    }),
  );
  const list = [...sessions.values()];
  const closeSessions = async () => {
    await Promise.allSettled(list.map((s) => s.close()));
    await queue.close();
  };
  // One object per vault, so `useSyncExternalStore` sees a stable snapshot.
  const unavailable = new Map<string, VaultSyncStatus>(
    [...missing].map(([vault, failure]) => [
      vault,
      { vault, phase: "failed", syncing: false, remote: true, unpushed: false, failure },
    ]),
  );
  const unavailableVaults = ready.paired.flatMap((entry) => {
    const failure = missing.get(entry.vaultId);
    return failure === undefined ? [] : [{ vault: entry.vaultId, name: entry.name, failure }];
  });
  const fallbackStore = fallback === null ? undefined : storeOf(fallback);
  // TRANSITIONAL(S44): no vault opened at all lands in the fatal state; the pairing screens take it.
  if (fallbackStore === undefined) throw new Error("no_vault");
  internals = { queue, logs: new Map(opened.map((v) => [v.vault, v.log])) };
  services = {
    client,
    device,
    store: fallbackStore,
    storeOf,
    profiles,
    vaults: {
      get: (vault) => sessions.get(vault),
      list: () => list,
      unavailable: (vault) => unavailable.get(vault),
      unavailableVaults: () => unavailableVaults,
    },
    sync: createSyncRunner({ targets: () => list, now: () => Date.now() }),
    prices,
    moneyQueries: createMoneyQueries(
      { prices, changes: prices },
      phoneInvestmentSources({ prices, now: () => new Date().toISOString() }),
    ),
    openMs,
    firstLoad,
    cryptoSelfTest,
    storage: storageInfo(),
    auth: localAuthenticator,
    isDemo: opened.every((v) => isDemoVault(v.vault)),
    closeSessions,
    close: servicesCloser({
      client,
      vaults: opened.flatMap((v) => [v.store, v.log]),
      prices,
      device,
    }),
  };
  return services;
}

// Removing this phone closes every engine (after its queued pass or command) before the databases go.
onBeforeWipe(async () => {
  await services?.closeSessions();
});

/** Forget the current services: the next boot opens every database again. */
function dropServices(): void {
  const current = services;
  services = undefined;
  internals = undefined;
  prepared = undefined;
  current?.close();
}

/**
 * Close the current services and build them again (the phone wipe). The caller remounts the tree with
 * `bumpEpoch()`; until then nothing may read the old services.
 */
function resetServices(): Services {
  dropServices();
  return bootServices();
}

/**
 * Close every engine and database and open them again over the current vault list (a vault was paired
 * or forgotten), then remount the root. The root shows the opening phase meanwhile.
 */
async function reopenServices(): Promise<void> {
  showOpening();
  try {
    await services?.closeSessions();
    dropServices();
    await prepareServices();
    bootServices();
    bumpEpoch("ready");
  } catch (error) {
    servicesFailure = codeOf(error);
    bumpEpoch("failed");
    throw error;
  }
}

/**
 * Keep a pairing welcome (after the phone read its member document: the pairing is committed): the
 * vault's open session, when this phone held the vault already, is closed and the store runs as one
 * task of the vault's queue (`storeJoinedInQueue`). `discardUnpushed`: the owner agreed to remove own
 * changes the relay never got. `addPairedVault` follows.
 */
export async function storeJoinedPairing(
  joined: JoinedVault,
  options: { readonly discardUnpushed: boolean },
): Promise<void> {
  const base = prepared?.base;
  const running = internals;
  if (base === undefined || running === undefined) throw new Error("services_not_prepared");
  const vault = joined.ring.vaultId;
  const held = running.logs.get(vault);
  const driver = held ?? openVaultLog(vault, base.key);
  try {
    await storeJoinedInQueue(
      {
        queue: running.queue,
        session: services?.vaults.get(vault),
        keyStore: phoneKeyStore(),
        driver,
        now: () => Date.now(),
      },
      joined,
      options,
    );
  } finally {
    if (held === undefined) driver.close();
  }
}

/**
 * Add a freshly paired vault to this phone (after `storeJoinedPairing` resolved) and reopen the services
 * over it: the root remounts, `PhoneSync`'s start trigger waits for the vault's open and runs its first
 * sync (`syncRunner.ts`), and `useVaultSyncStatus(vault)` shows the progress (`receiving`) until the
 * profile has arrived (`ready`). Also a role change (the same vault's entry replaced).
 */
export async function addPairedVault(entry: PairedVault): Promise<void> {
  const base = prepared?.base;
  if (base === undefined) throw new Error("services_not_prepared");
  // The log's copy first: a device store recreated later rebuilds the list from it.
  const held = internals?.logs.get(entry.vaultId);
  const log = held ?? openVaultLog(entry.vaultId, base.key);
  try {
    savePairedEntry(log, entry);
  } finally {
    if (held === undefined) log.close();
  }
  const saved = base.device.run(savePairedVault, entry);
  if (!saved.ok) throw new Error(saved.reason);
  await reopenServices();
}

/** Change whose phone this is for one paired vault (the pairing's last step, the profile sheet). */
export async function setPairedVaultRole(vault: string, role: ProfileRole): Promise<void> {
  const base = prepared?.base;
  if (base === undefined) throw new Error("services_not_prepared");
  const entry = pairedOf(base.device).find((e) => e.vaultId === vault);
  if (entry === undefined) throw new Error("vault_not_paired");
  if (entry.role === role) return;
  await addPairedVault({ ...entry, role });
}

/**
 * Remove one paired vault's copy from this phone (the removed and sync-off states offer it, never
 * automatically): every engine and database closes, then `forgetVault` deletes the vault's log FIRST
 * (its copy of the list entry would otherwise restore it), its view, the list entry and its keys; the
 * services open again over what is left (no paired vault left: the demo, and the pairing screen).
 */
export async function forgetThisVault(vault: string): Promise<void> {
  showOpening();
  try {
    await services?.closeSessions();
    const entry = prepared?.base === undefined ? undefined : pairedOf(prepared.base.device);
    const device = entry?.find((e) => e.vaultId === vault)?.deviceId;
    const others = entry?.filter((e) => e.vaultId !== vault) ?? [];
    dropServices();
    const base = openBase();
    const keyStore = phoneKeyStore();
    try {
      await forgetVault({
        deleteLog: () => deleteDatabaseFile(`log-${vault}.db`),
        deleteView: () => deleteDatabaseFile(`vault-${vault}.db`),
        forgetEntry: () => base.device.run(forgetPairedVault, { vaultId: vault }).ok,
        deleteKeys: async () => {
          await keyStore.delete(crypto.keyringName(vault));
          // One identity per pairing; kept while another vault still names it.
          if (device !== undefined && !others.some((e) => e.deviceId === device)) {
            await keyStore.delete(crypto.deviceIdentityName(device));
          }
        },
      });
    } finally {
      base.device.close();
      base.prices.close();
    }
    await prepareServices();
    bootServices();
    bumpEpoch("ready");
  } catch (error) {
    servicesFailure = codeOf(error);
    bumpEpoch("failed");
    throw error;
  }
}

/**
 * "Remove this phone": cancel and dismiss our notifications, close every engine, delete every
 * database, key and file this app wrote on the phone, then rebuild the services and remount (or show
 * the fatal state when that could not be done safely). Rejects only when the rebuilt app is shown
 * although a step failed; the fatal state is its own report. TRANSITIONAL(S44): the rebuild lands on
 * the companion demo; a paired phone lands on the pairing screen.
 */
export async function wipeThisPhone(): Promise<void> {
  const current = bootServices();
  await wipeDevice({
    showWiping,
    beforeWipe: beforeWipeTasks(),
    deleteSecrets: async () => {
      // The Keychain items, both service "cashu", one after the other (`deletePhoneSecrets`: a kill
      // between them is finished by the next launch): the database key `cashu.db.key`, then the
      // KeyStore's key-encryption key `cashu.keystore.kek` (which seals the identities, keyrings and
      // the relay identity under `keys/`).
      try {
        await deletePhoneSecrets({
          deleteDbKey: () => phoneDbKey.delete(),
          deleteKek: deleteKeyStoreKek,
        });
      } finally {
        // The instance caches the deleted key: the rebuild seals under a new one.
        keyStoreInstance = undefined;
      }
    },
    // A macrotask, so React has committed the "Removing" state and the UI thread can draw it while the
    // synchronous close and rebuild hold the JS thread.
    nextFrame,
    close: () => current.close(),
    // Everything the app writes under <Documents>: `SQLite/` (every `*.db` with its -wal, -shm and
    // -journal sidecars: the vault views and logs, `device.db`, `market.db`), `keys/` (the KeyStore's
    // sealed values), `bench/` (the measurement log) and `language-pin.txt` (the language choice). The
    // rebuild writes the demo's databases (and a bench line) again.
    deleteFiles: () => {
      deleteKeyStoreFiles();
      deleteBenchLogs();
      deleteLanguagePin();
      deleteDatabaseFiles();
    },
    reset: () => void resetServices(),
    remount: bumpEpoch,
  });
}

/** A value-free code for a bench line. */
function codeOf(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_-]{1,64}$/u.test(error.message)) return error.message;
  return "unknown";
}
