// Test helpers for the sync relay on the host: a virtual clock for the relay's timers, relay options
// over the in-memory Firebase fake (`demo-cashu`, never a real project), a harness that starts native
// hosts of one synthetic vault against one fake, and a second native data dir for the synthetic peer
// device of a `nativeVaultFixture` (its own keys, log copy, stores), so two hosts can converge through
// one fake relay.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHost, type HostConnection } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { builtinModules, renameProfile, Store, vaultSalt } from "@cashu/store";
import { DeviceStore, type RelaySetting, setRelaySetting } from "@cashu/store/device";
import { initializeMetaClockGuard, SqlProvenanceStore } from "@cashu/store/sync";
import { crypto, devices } from "@cashu/sync";
import {
  createFakeFirebase,
  type FakeFirebase,
  InMemoryKeyStore,
  MemoryAuthStore,
} from "@cashu/sync/testing";
import { SqlAttemptJournal } from "../attemptJournal.js";
import { runHostVaultCommand } from "../commands.js";
import { type LocalHost, type LocalHostOptions, startLocalHost } from "../host.js";
import { memoryLog } from "../log.js";
import type { HostRelayOptions, RelayTimers } from "../relay/service.js";
import { storeFiles } from "../stores.js";
import type { NativeVaultInventoryEntry } from "../sync/keys/deviceAuthority.js";
import { type NativeVaultFixture, nativeVaultFixture } from "./nativeVaultFixture.js";

interface Scheduled {
  at: number;
  readonly every: number | undefined;
  readonly run: () => void;
  cancelled: boolean;
}

/** A virtual clock: callbacks run only when the test advances it. */
export class ManualRelayTimers implements RelayTimers {
  #time: number;
  readonly #scheduled: Scheduled[] = [];

  constructor(start = Date.UTC(2026, 10, 14, 9, 0, 0)) {
    this.#time = start;
  }

  readonly now = (): number => this.#time;

  after(ms: number, run: () => void): () => void {
    return this.#add(ms, undefined, run);
  }

  every(ms: number, run: () => void): () => void {
    return this.#add(ms, ms, run);
  }

  /** Delays still scheduled, from now. */
  pendingDelays(): number[] {
    return this.#scheduled.filter((s) => !s.cancelled).map((s) => s.at - this.#time);
  }

  /** Moves the clock `ms` forward, running every callback that falls due (in time order). */
  advance(ms: number): void {
    const target = this.#time + ms;
    for (;;) {
      const due = this.#scheduled
        .filter((s) => !s.cancelled && s.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.#time = Math.max(this.#time, due.at);
      if (due.every === undefined) due.cancelled = true;
      else due.at += due.every;
      due.run();
    }
    this.#time = target;
    for (let i = this.#scheduled.length - 1; i >= 0; i--)
      if (this.#scheduled[i]?.cancelled) this.#scheduled.splice(i, 1);
  }

  #add(ms: number, every: number | undefined, run: () => void): () => void {
    const entry: Scheduled = { at: this.#time + Math.max(0, ms), every, run, cancelled: false };
    this.#scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }
}

/** Relay options over the fake: synthetic project, memory identity, no retries, the virtual clock. */
export function fakeRelayOptions(
  fake: FakeFirebase,
  timers: ManualRelayTimers,
  auth: MemoryAuthStore = new MemoryAuthStore(),
): HostRelayOptions & { readonly auth: MemoryAuthStore } {
  return {
    endpoints: {
      projectId: fake.endpoint.projectId,
      target: "emulator",
      firestore: fake.endpoint,
      identity: fake.identity,
    },
    authStore: () => auth,
    fetch: fake.fetch,
    retries: 0,
    timers,
    now: timers.now,
    auth,
  };
}

/** The exit code of a handover stop. */
export const HANDOVER_EXIT_CODE = 75;

/** One synthetic native vault, one fake relay, one virtual clock; hosts started on demand. */
export interface RelayHostEnv {
  readonly fixture: NativeVaultFixture;
  readonly fake: FakeFirebase;
  readonly timers: ManualRelayTimers;
  readonly relay: ReturnType<typeof fakeRelayOptions>;
  readonly vault: string;
  /** Starts the data dir's host (`relay` overrides the fake's options; null: no relay config). */
  start(relay?: HostRelayOptions | null): Promise<LocalHost>;
  ui(): Promise<HostConnection>;
}

/** Starts relay test hosts and stops / removes everything they made in `cleanup`. */
export function relayHarness() {
  const fixtures: NativeVaultFixture[] = [];
  const hosts: LocalHost[] = [];
  const clients: HostConnection[] = [];
  return {
    async setup(options: { readonly relay?: boolean } = {}): Promise<RelayHostEnv> {
      const fixture = await nativeVaultFixture({ modules: ["budget"] });
      fixtures.push(fixture);
      const fake = createFakeFirebase();
      const timers = new ManualRelayTimers();
      const relay = fakeRelayOptions(fake, timers);
      return {
        fixture,
        fake,
        timers,
        relay,
        vault: fixture.vaultId,
        async start(override?: HostRelayOptions | null) {
          const chosen =
            override === undefined ? (options.relay === false ? null : relay) : override;
          const hostOptions: LocalHostOptions = {
            dataDir: fixture.dataDir,
            home: fixture.home,
            build: "test",
            launcher: false,
            log: memoryLog(),
            vaultSource: fixture.vaultSource,
            ...(chosen === null ? {} : { relay: chosen }),
          };
          const host = await startLocalHost(hostOptions);
          hosts.push(host);
          return host;
        },
        async ui() {
          const client = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "test" });
          clients.push(client);
          return client;
        },
      };
    },
    async cleanup(): Promise<void> {
      for (const client of clients.splice(0)) client.close();
      for (const host of hosts.splice(0)) await host.stop().catch(() => {});
      for (const fixture of fixtures.splice(0)) fixture.cleanup();
    },
  };
}

/** Bytes the vault holds at the fake relay (committed segment sizes). */
export function relayBytes(fake: FakeFirebase, vault: string): number {
  let total = 0;
  for (const [path, doc] of fake.documents(`vaults/${vault}/segments/`)) {
    if (path.includes("/chunks/")) continue;
    const size = doc.fields.size;
    if (size !== undefined && "integerValue" in size) total += Number(size.integerValue);
  }
  return total;
}

/** Every request the fake received (Firestore and identity). */
export function relayRequests(fake: FakeFirebase): number {
  return Object.values(fake.counters).reduce((sum, n) => sum + n, 0);
}

/**
 * The fake's fetch with the security rules' membership check in short (the fake runs no rules): once a
 * vault document exists, a Firestore request under it by a uid without a member document there is
 * refused 403, as `member(v)` / `admin(v)` refuse it. The bootstrap commit of a vault that does not
 * exist yet passes. Identity requests pass unchanged.
 */
export function membersOnlyFetch(fake: FakeFirebase): FakeFirebase["fetch"] {
  return async (url, init) => {
    const vault = /\/documents\/vaults\/([0-9a-f]{32})/.exec(decodeURIComponent(url))?.[1];
    const caller = /^Bearer fake-id-token:([^:]+):/.exec(init.headers.Authorization ?? "")?.[1];
    const commitTargets =
      vault === undefined && url.endsWith(":commit")
        ? [...(init.body ?? "").matchAll(/vaults\/([0-9a-f]{32})/g)].map((m) => m[1])
        : [];
    for (const v of vault === undefined ? commitTargets : [vault]) {
      const docs = fake.documents(`vaults/${v}`);
      if (docs.has(`vaults/${v}`) && !docs.has(`vaults/${v}/members/${caller ?? ""}`)) {
        const text = JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED" } });
        return { status: 403, text: async () => text, json: async () => JSON.parse(text) };
      }
    }
    return fake.fetch(url, init);
  };
}

/** Enables the vault over the RPC and restarts the host the handover stopped; its first push done. */
export async function enabledRelayHost(
  env: RelayHostEnv,
  relay: HostRelayOptions = env.relay,
): Promise<LocalHost> {
  const first = await env.start(relay);
  const client = await env.ui();
  const enabled = await client.call("native.relay.enable", { vault: env.vault });
  if ((enabled as { kind?: string }).kind !== "done") throw new Error("relay enable refused");
  if ((await first.exit) !== HANDOVER_EXIT_CODE) throw new Error("no handover after enable");
  client.close();
  const host = await env.start(relay);
  env.timers.advance(0);
  await until(() => host.relay.pending() === 0 && relayBytes(env.fake, env.vault) > 0);
  return host;
}

/** A synthetic own write (a profile rename) through the host's command path. */
export async function renameVault(host: LocalHost, vault: string, name: string): Promise<void> {
  const opened = host.stores.vaults.get(vault);
  if (opened === undefined) throw new Error("vault not open");
  const result = await runHostVaultCommand(opened, renameProfile, { name }, `rename-${name}`);
  if (result.kind !== "completed") throw new Error(`rename ${result.kind}`);
}

/** Resolves once everything queued for the vault before this call ran (passes included). */
export async function vaultQueueDrained(host: LocalHost, vault: string): Promise<void> {
  const session = host.stores.vaults.get(vault)?.native;
  if (session === undefined) throw new Error("vault not open");
  await session.queue.run(async () => {});
}

/**
 * Counts every engine pass of the vault (whoever starts it) and can hold the next ones at a gate
 * until `release()`.
 */
export function enginePasses(host: LocalHost, vault: string) {
  const session = host.stores.vaults.get(vault)?.native;
  if (session === undefined) throw new Error("vault not open");
  const engine = session.engine;
  const original = engine.sync.bind(engine);
  const passes = {
    count: 0,
    running: 0,
    gate: undefined as Promise<void> | undefined,
    release: () => {},
    hold() {
      passes.gate = new Promise<void>((resolve) => {
        passes.release = () => {
          passes.gate = undefined;
          resolve();
        };
      });
    },
  };
  engine.sync = async () => {
    passes.count += 1;
    passes.running += 1;
    try {
      if (passes.gate !== undefined) await passes.gate;
      return await original();
    } finally {
      passes.running -= 1;
    }
  };
  return passes;
}

/** Polls `check` until true (5 s). */
export async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Writes a relay switch into a data dir's device store before its host starts. */
export function presetRelaySetting(dataDir: string, vault: string, value: RelaySetting): void {
  const files = storeFiles(dataDir);
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  const driver = openNodeSqlite(files.deviceDb);
  try {
    const device = DeviceStore.open(driver);
    const written = device.run(setRelaySetting, { vault, value });
    if (!written.ok) throw new Error(written.reason);
  } finally {
    driver.close();
  }
}

export interface PeerDataDir {
  readonly dataDir: string;
  readonly home: string;
  readonly device: string;
  readonly vaultSource: {
    readonly kind: "native";
    readonly provider: {
      readonly inventory: readonly NativeVaultInventoryEntry[];
      readonly keyStore: InMemoryKeyStore;
      readonly sodium: crypto.Sodium;
      bootstrapCertificates(): Promise<readonly Uint8Array[]>;
    };
  };
  cleanup(): void;
}

/**
 * The synthetic peer of `fixture` (made with `pairPeer: true`) as its own native data dir: the vault's
 * ring and the peer identity in a memory key store, pairing provenance, empty stores and a copy of the
 * creator's log (which holds the peer's `device.added`), as a completed pairing would leave it.
 */
export async function peerDataDir(fixture: NativeVaultFixture): Promise<PeerDataDir> {
  const identity = fixture.peerIdentity;
  const peerCertificate = fixture.peerCertificate;
  if (identity === undefined || peerCertificate === undefined)
    throw new Error("the fixture has no synthetic peer");
  const { provider } = fixture.vaultSource;
  const creator = provider.inventory[0];
  if (creator === undefined) throw new Error("the fixture has no vault");
  const ring = await crypto.loadKeyring(provider.keyStore, provider.sodium, fixture.vaultId);
  if (ring === null) throw new Error("synthetic keyring absent");
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-native-peer-")));
  const home = join(dataDir, "test-home");
  mkdirSync(home);
  const vaultRoot = join(dataDir, "vaults", fixture.vaultId);
  try {
    mkdirSync(join(vaultRoot, "strategy"), { recursive: true, mode: 0o700 });
    chmodSync(join(dataDir, "vaults"), 0o700);
    chmodSync(vaultRoot, 0o700);
    cpSync(join(creator.vaultRoot, "log"), join(vaultRoot, "log"), { recursive: true });
    chmodSync(join(vaultRoot, "log"), 0o700);
    const keyStore = new InMemoryKeyStore();
    await crypto.saveKeyring(keyStore, ring);
    await crypto.saveDeviceIdentity(keyStore, identity);
    const meta = openNodeSqlite(join(vaultRoot, "private.db"));
    try {
      const provenance = SqlProvenanceStore.open(meta, ring, "new");
      devices.recordPairingProvenance(provenance, ring, creator.deviceId, Date.now());
      SqlAttemptJournal.open(meta, "new", Date.now);
    } finally {
      meta.close();
    }
    const saltKey = ring.gidSalt();
    const store = Store.open({
      driver: openNodeSqlite(join(vaultRoot, "view.db")),
      vault: fixture.vaultId,
      salt: vaultSalt(saltKey.expose().slice()),
      modules: builtinModules(),
    });
    saltKey.wipe();
    initializeMetaClockGuard(store.driver, identity.deviceId);
    store.close();
    const creatorCertificates = await provider.bootstrapCertificates();
    const entry: NativeVaultInventoryEntry = {
      vaultId: fixture.vaultId,
      deviceId: identity.deviceId,
      vaultRoot,
      state: "ready",
      enrollment: "pairing",
    };
    return {
      dataDir,
      home,
      device: identity.deviceId,
      vaultSource: {
        kind: "native",
        provider: {
          inventory: [entry],
          keyStore,
          sodium: provider.sodium,
          bootstrapCertificates: async () => [
            ...creatorCertificates.map((c) => c.slice()),
            peerCertificate.slice(),
          ],
        },
      },
      cleanup() {
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  } finally {
    ring.wipe();
  }
}
