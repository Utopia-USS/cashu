// The sync relay on the Mac host (M4-C sections 1 and 2): per vault, an owner switch on this device
// (`relay.<vaultId>` in the device store, default off) that adds the Firestore transport as a remote of
// the vault's engine, and the triggers that run its passes:
//   - at vault open (a first full push after enabling),
//   - 2 s after own writes (debounced, coalescing),
//   - every 5 minutes while the host runs (a pull at most every 60 s),
//   - every 5 s while a pairing of the vault waits for the new phone's first sync (`watchPairing`, at
//     most 3 minutes after the admission; then the 5-minute schedule again),
//   - a final push before the idle exit,
// each one a normal session pass in the vault queue (`session.sync()`), throttled by the back-off of
// relay/policy.ts. The engine reads its remotes once at open, so switching a vault on or off writes the
// setting and the caller reopens the vaults (the host's handover). Until then the vault is halted:
// `disable` and `purge` stop its triggers before anything else runs, and the remote the engine holds
// answers `unavailable` (so no pass of any caller, a fetch-lease refresh included, reaches the relay
// between the action and the reopen). The same gate holds the remote shut until `start` (safe mode
// never starts it) and after `close`. A missing config hides everything: no remote, every action
// refused `no_config`.
//
// The relay sees opaque ids, sizes and sealed frames only. One anonymous uid per data dir (keychain);
// when its refresh token is refused the identity is replaced and every enabled vault is marked
// `identityLostAt` (the status reports it until a pass reaches the relay again, or the owner
// reconnects).
//
// Membership goes through `FirestoreRelayAdmin`. Enabling a vault makes this Mac its first admin with
// a recovery secret: 32 random bytes per vault, created here, kept only in the OS keychain beside the
// relay identity (`@cashu/node-host/relay-auth`), stored BEFORE the commit that writes its hash, so a
// crash never leaves a hash at the relay whose secret is gone. `reconnect` spends it after an identity
// loss: the new uid becomes admin again under a NEW secret (stored before that commit, the old one kept
// until the commit is confirmed), then the lost uid's member document goes.
import { randomBytes } from "node:crypto";
import type { RelayActionResult, RelayStatusResult } from "@cashu/host-protocol";
import type { HostLock } from "@cashu/node-host";
import type { RelayRecoveryRecord, RelayRecoverySecrets } from "@cashu/node-host/relay-auth";
import {
  type DeviceStore,
  type RelayMemberRole,
  type RelaySetting,
  relayDeviceRole,
  relayMemberRole,
  relayMemberUid,
  relaySetting,
  relaySettings,
  setRelaySetting,
} from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import {
  type AnonymousAuth,
  type AuthStore,
  FirestorePairingLink,
  FirestoreRelayAdmin,
  FirestoreRest,
  FirestoreRestError,
  FirestoreTransport,
  type PullHistory,
  type RelayMember,
  type RelayStatus,
  relayRecoveryHash,
  type StuckRecord,
  type Transport,
  TransportError,
} from "@cashu/sync";
import { errorName, type HostLog } from "../log.js";
import type { NativeVaultSession, NativeVaultSource } from "../nativeVault.js";
import type { HostStores } from "../stores.js";
import type { NativeVaultInventoryEntry } from "../sync/keys/deviceAuthority.js";
import { type RelayFetch, relayIdentity } from "./auth.js";
import type { RelayEndpoints } from "./config.js";
import {
  RELAY_FINAL_PUSH_TIMEOUT_MS,
  RELAY_PULL_INTERVAL_MS,
  RELAY_PUSH_DEBOUNCE_MS,
  RELAY_WATCH_MAX_MS,
  RELAY_WATCH_PULL_MS,
  type RelayDirection,
  type RelayPassReason,
  RelayPolicy,
} from "./policy.js";

const DEFAULT_ROOT = "vaults";
/** Bytes of a vault's relay recovery secret. */
const RECOVERY_SECRET_BYTES = 32;
/**
 * The persisted last complete pull moves only in steps this large (G2): one device-store write per
 * minute at most, never one per pass; the 7-day bound is a minute shorter at worst.
 */
const HISTORY_WRITE_STEP_MS = 60_000;

/** Timers the service schedules with (tests pass a manual clock). */
export interface RelayTimers {
  /** Runs `run` once after `ms`; returns its cancel. Never keeps the process alive. */
  after(ms: number, run: () => void): () => void;
  /** Runs `run` every `ms`; returns its cancel. Never keeps the process alive. */
  every(ms: number, run: () => void): () => void;
}

const nodeRelayTimers: RelayTimers = {
  after(ms, run) {
    const handle = setTimeout(run, ms);
    handle.unref();
    return () => clearTimeout(handle);
  },
  every(ms, run) {
    const handle = setInterval(run, ms);
    handle.unref();
    return () => clearInterval(handle);
  },
};

/** What the composition root binds when this host has a relay config (absent: no relay at all). */
export interface HostRelayOptions {
  readonly endpoints: RelayEndpoints;
  /** The data dir's relay identity store, bound to the held host lock (the keychain in production). */
  readonly authStore: (lock: HostLock) => AuthStore;
  /**
   * The vaults' relay recovery secrets, bound to the held host lock (the keychain in production).
   * Absent: no secret is kept, a vault is created without a recovery hash and `reconnect` answers
   * `no_recovery_secret`.
   */
  readonly recoverySecrets?: (lock: HostLock) => RelayRecoverySecrets;
  readonly fetch?: RelayFetch;
  /** Collection prefix, default "vaults" (the only one the security rules match). */
  readonly root?: string;
  /** REST retries per request (default 1). */
  readonly retries?: number;
  readonly timers?: RelayTimers;
  /** The relay's clock (policy, status times); default the host's. Tests pair it with `timers`. */
  readonly now?: () => number;
}

/** An owner action's result and whether the vaults must reopen (their engine's remotes changed). */
export interface RelayOutcome {
  readonly result: RelayActionResult;
  readonly reopen: boolean;
}

interface RelayHostContext {
  readonly stores: HostStores;
  /** No new host work (stopping, handover). */
  readonly closing: () => boolean;
}

export interface HostRelay {
  readonly configured: boolean;
  /** The configured relay project (the QR's `rv` hint is `fb1:<projectId>`); undefined without one. */
  readonly projectId: string | undefined;
  /** Adds the relay remote to each vault enabled on this device; read once per vault open. */
  wrapSource(source: NativeVaultSource): NativeVaultSource;
  /** The device store, opened before the vaults: their open reads the switch from it. */
  attachDevice(device: DeviceStore): void;
  /** After the stores opened: the triggers start (an immediate pass per enabled vault). */
  start(context: RelayHostContext): void;
  /**
   * Passes running or pushes waiting for their debounce (an idle host waits for them). A retry
   * waiting out a back-off is not counted (an offline Mac would never idle out): the final push
   * covers those writes.
   */
  pending(): number;
  /**
   * Before the idle exit: one attempt, back-off ignored, to push own writes not yet at the relay.
   * Resolves after `timeoutMs` at the latest, or at once when `signal` aborts (a stronger stop).
   */
  finalPush(options?: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<void>;
  /** No more passes; requests in flight are aborted. */
  close(): void;
  /** The desktop row's status (value-free). */
  status(vault: string): RelayStatusResult;
  /** The transport's last call outcome for the vault (diagnostics and tests; never sent to a client). */
  transportStatus(vault: string): RelayStatus;
  enable(vault: string): Promise<RelayOutcome>;
  disable(vault: string): Promise<RelayOutcome>;
  purge(vault: string): Promise<RelayOutcome>;
  /**
   * After an identity loss: re-admits this Mac's new uid with the vault's recovery secret, removes the
   * lost uid's membership and resumes the passes. Never reopens the vaults (the remote is unchanged).
   */
  reconnect(vault: string): Promise<RelayOutcome>;
  /**
   * G2 override, the owner's "keep fetching on this Mac": only while the offline bound refuses this
   * Mac as the pinned fetch leader (the device list's `leader.paused`), records the acknowledgement
   * time in the vault's relay setting (`offlineLeadAckAt`; the next complete pull clears it), so the
   * bound counts OFFLINE_LEAD_MAX_MS from it (lease.ts `offlinePullAt`). Refused `busy` otherwise:
   * never in mode auto, never for another refusal (removed, identity lost, rollback). Never reopens.
   */
  keepFetching(vault: string): Promise<RelayOutcome>;
  /**
   * The owner's "Try now" of a failing membership removal: a relay pass of the vault now (its
   * back-off still holds: `offline` while it runs); the removals are retried after every pass
   * (pairing/members.ts). Never reopens.
   */
  syncNow(vault: string): Promise<RelayOutcome>;
  /**
   * Admin only: binds `uid` to `device` at the relay with `role` (`member` for a phone) and records it
   * with its role in the vault's relay setting (an older binding of the same uid, an earlier pairing of
   * the same phone, is dropped: the member document is keyed by the uid and was overwritten). Throws
   * the relay's error (value-free) when the relay write fails; a setting that cannot be written after
   * it is only logged (the reconciliation adopts the membership, `adoptMembers`).
   */
  addMember(
    vault: string,
    input: { readonly device: string; readonly uid: string; readonly role: RelayMemberRole },
  ): Promise<void>;
  /** Admin only: removes `device`'s membership at the relay and from the setting (none: no-op). */
  removeMember(vault: string, device: string): Promise<void>;
  /**
   * Every member document of the vault at the relay (the reconciliation, the pairing preflight).
   * Throws `relay_off` unless the vault's relay was enabled on this project here (on or off now).
   */
  listMembers(vault: string): Promise<readonly RelayMember[]>;
  /** Admin only: removes a member document by its uid (a stray one) and any setting entry naming it. */
  removeStrayMember(vault: string, uid: string): Promise<void>;
  /**
   * Records what the relay's member list says in the vault's setting: each listed device's kind
   * (`roles`, also the role of a legacy bare entry) and the binding of a registered device the setting
   * lacks (a membership whose setting write was lost). Never removes anything.
   */
  adoptMembers(
    vault: string,
    members: readonly RelayMember[],
    registered: ReadonlySet<string>,
  ): Promise<void>;
  /**
   * The membership removals of revoked devices that keep failing (pairing/members.ts), shown in the
   * status (`removalsFailing`); undefined clears it.
   */
  noteRemovalsFailing(
    vault: string,
    failing:
      | { readonly devices: number; readonly since: number; readonly ids: readonly string[] }
      | undefined,
  ): void;
  /**
   * Deletes the vault's pairing sessions (and their messages) whose `expiresAt` is more than `graceMs`
   * past: what a host crash or a failed close left at the relay. Best effort; returns how many went.
   */
  pruneExpiredPairings(vault: string, graceMs: number): Promise<number>;
  /** Asks for a pull pass of the vault soon (its policy still spaces pulls); no-op when off. */
  requestPull(vault: string): void;
  /**
   * A pairing of the vault was admitted and waits for the new phone's first sync: pulls the vault
   * every 5 s (the policy's back-off and quota hour still hold them) until the returned stop is called
   * or 3 minutes passed, whichever comes first. Watches of one vault share one timer. No-op when off.
   */
  watchPairing(vault: string): () => void;
  /**
   * The inviter's pairing link of one session over this Mac's own relay identity and client. Throws
   * `relay_off` when the vault's relay is not switched on here (`relay_no_config` without a config).
   */
  pairingLink(vault: string, sessionId: string): FirestorePairingLink;
}

interface VaultRelay {
  /** The transport behind the engine's (gated) remote of this session. */
  readonly transport: FirestoreTransport;
  readonly policy: RelayPolicy;
  /**
   * Halted by `disable` / `purge` (set before they run anything, kept while the switch is off): no
   * trigger runs a pass and the engine's remote answers `unavailable` until the vaults reopen.
   */
  stopped: boolean;
  /** Own writes since the last pass that reached the relay. */
  dirty: boolean;
  /** A push requested while a pass ran: one more pass after it. */
  again: boolean;
  running: Promise<void> | undefined;
  cancelDebounce: (() => void) | undefined;
  cancelRetry: (() => void) | undefined;
  unsubscribe: (() => void) | undefined;
  lastSyncAt: number | undefined;
  /** D7: the engine's stuck records after the last relay pass. */
  stuck: readonly StuckRecord[];
  /**
   * The final push runs now: the remote lets it through a running back-off (every other caller is
   * refused at once while one runs, S6).
   */
  finalPass: boolean;
}

/** The record a pass met first (ties: the lower device id). */
const first = (records: readonly StuckRecord[]): StuckRecord | undefined =>
  records.reduce<StuckRecord | undefined>(
    (best, r) =>
      best === undefined ||
      r.firstSeenAt < best.firstSeenAt ||
      (r.firstSeenAt === best.firstSeenAt && r.device < best.device)
        ? r
        : best,
    undefined,
  );

/** D7: the value-free status summary of the engine's stuck records. */
export function stuckSummary(records: readonly StuckRecord[]): RelayStatusResult["stuck"] {
  if (records.length === 0) return undefined;
  const open = records.filter((r) => r.kind !== "final");
  const oldest = open.reduce<StuckRecord | undefined>(
    (best, r) => (best === undefined || r.firstSeenAt < best.firstSeenAt ? r : best),
    undefined,
  );
  // The writer the status line names: the oldest rejected stream first (the worse state), else the
  // oldest waiting one. Only its device id goes out; the window names it from its device list.
  const shown =
    first(open.filter((r) => r.kind === "rejected")) ??
    first(open.filter((r) => r.kind === "waiting"));
  return {
    waiting: records.filter((r) => r.kind === "waiting").length,
    rejected: records.filter((r) => r.kind === "rejected").length,
    final: records.filter((r) => r.kind === "final").length,
    ...(oldest === undefined ? {} : { since: oldest.firstSeenAt }),
    ...(shown === undefined ? {} : { device: shown.device }),
    passes: open.reduce((most, r) => Math.max(most, r.passes), 0),
  };
}

const done = (reopen: boolean): RelayOutcome => ({ result: { kind: "done" }, reopen });
const refused = (
  reason: Extract<RelayActionResult, { kind: "refused" }>["reason"],
): RelayOutcome => ({ result: { kind: "refused", reason }, reopen: false });

/** The status of a vault without the relay on this host (also the answer to invalid params). */
export const HIDDEN_STATUS: RelayStatusResult = {
  configured: false,
  enabled: false,
  devices: 0,
  identityLost: false,
  canReconnect: false,
};

/** A relay error that says the relay could not be reached (or this Mac could not sign in). */
function unreachable(error: unknown): boolean {
  return (
    !(error instanceof FirestoreRestError) ||
    error.code === "unavailable" ||
    error.code === "resource-exhausted" ||
    error.code === "unauthenticated"
  );
}

const newRecoverySecret = (): Uint8Array => new Uint8Array(randomBytes(RECOVERY_SECRET_BYTES));

/** The kept device kinds plus `extra` (a purge or removal drops the binding, never the kind). */
function keptRoles(
  setting: RelaySetting,
  extra: Readonly<Record<string, RelayMemberRole>> = {},
): Pick<RelaySetting, "roles"> {
  const roles: Record<string, RelayMemberRole> = { ...setting.roles };
  for (const [device, entry] of Object.entries(setting.memberUids)) {
    const role = relayMemberRole(entry);
    if (role !== undefined) roles[device] ??= role;
  }
  Object.assign(roles, extra);
  return Object.keys(roles).length === 0 ? {} : { roles };
}

/** The relay of a host without a config: nothing is wired, every action is refused `no_config`. */
function unconfiguredRelay(): HostRelay {
  return {
    configured: false,
    projectId: undefined,
    wrapSource: (source) => source,
    attachDevice() {},
    start() {},
    pending: () => 0,
    finalPush: () => Promise.resolve(),
    close() {},
    status: () => HIDDEN_STATUS,
    transportStatus: () => ({}),
    enable: () => Promise.resolve(refused("no_config")),
    disable: () => Promise.resolve(refused("no_config")),
    purge: () => Promise.resolve(refused("no_config")),
    reconnect: () => Promise.resolve(refused("no_config")),
    keepFetching: () => Promise.resolve(refused("no_config")),
    syncNow: () => Promise.resolve(refused("no_config")),
    addMember: () => Promise.reject(new Error("relay_no_config")),
    removeMember: () => Promise.reject(new Error("relay_no_config")),
    listMembers: () => Promise.reject(new Error("relay_no_config")),
    removeStrayMember: () => Promise.reject(new Error("relay_no_config")),
    adoptMembers: () => Promise.resolve(),
    noteRemovalsFailing() {},
    requestPull() {},
    watchPairing: () => () => {},
    pruneExpiredPairings: () => Promise.resolve(0),
    pairingLink: () => {
      throw new Error("relay_no_config");
    },
  };
}

export function createHostRelay(input: {
  readonly options: HostRelayOptions | undefined;
  readonly lock: HostLock;
  readonly now: () => number;
  readonly log: HostLog;
}): HostRelay {
  const { options, lock, log } = input;
  if (options === undefined) return unconfiguredRelay();
  const now = options.now ?? input.now;
  const { endpoints } = options;
  const root = options.root ?? DEFAULT_ROOT;
  const timers = options.timers ?? nodeRelayTimers;
  const vaults = new Map<string, VaultRelay>();
  const busy = new Set<string>();
  /** Membership removals of revoked devices that keep failing, per vault (members.ts reports them). */
  const removalsFailing = new Map<
    string,
    { readonly devices: number; readonly since: number; readonly ids: readonly string[] }
  >();
  let device: DeviceStore | undefined;
  let context: RelayHostContext | undefined;
  let closed = false;
  let cancelPull: (() => void) | undefined;
  /** Running pairing watches per vault (their deadlines on the relay clock) and the vault's 5 s timer. */
  const watches = new Map<string, { readonly until: Set<{ at: number }>; cancel: () => void }>();
  let auth: AnonymousAuth | undefined;
  let rest: FirestoreRest | undefined;
  // Every relay request carries this signal: `close` aborts what is still in flight, so a stop never
  // waits out a request timeout.
  const inFlight = new AbortController();
  const baseFetch: RelayFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const fetch: RelayFetch = (url, init) =>
    baseFetch(url, {
      ...init,
      signal:
        init.signal === undefined
          ? inFlight.signal
          : AbortSignal.any([init.signal, inFlight.signal]),
    });
  // Built on first use, inside a promise: a keychain that cannot be reached fails a request
  // (`offline`), never the host start that opens the vaults.
  let secretStore: AuthStore | undefined;
  const authStore = (): AuthStore => {
    secretStore ??= options.authStore(lock);
    return secretStore;
  };
  const lazyAuthStore: AuthStore = {
    load: async () => authStore().load(),
    save: async (record) => authStore().save(record),
    clear: async () => authStore().clear(),
  };

  let recoveryStore: RelayRecoverySecrets | undefined;
  /** Built on first use like the identity store; undefined when the host keeps no secrets. */
  const recovery = (): RelayRecoverySecrets | undefined => {
    if (options.recoverySecrets === undefined) return undefined;
    recoveryStore ??= options.recoverySecrets(lock);
    return recoveryStore;
  };
  /** Vaults whose recovery secret this Mac holds (read from the keychain at most once per change). */
  const recoverable = new Map<string, boolean>();
  const refreshRecoverable = async (vault: string): Promise<void> => {
    const store = recovery();
    if (store === undefined) return;
    try {
      recoverable.set(vault, (await store.get(vault)) !== null);
    } catch {
      recoverable.delete(vault);
    }
  };

  const identity = (): AnonymousAuth => {
    auth ??= relayIdentity({
      endpoint: endpoints.identity,
      store: lazyAuthStore,
      now,
      fetch,
      onIdentityLost: () => void markIdentityLost(),
    });
    return auth;
  };
  const client = (): FirestoreRest => {
    rest ??= new FirestoreRest({
      endpoint: endpoints.firestore,
      auth: identity(),
      fetch,
      ...(options.retries === undefined ? {} : { retries: options.retries }),
    });
    return rest;
  };
  const newTransport = () =>
    new FirestoreTransport({ rest: client(), uid: () => identity().uid(), root, now });
  const relayAdmin = () => new FirestoreRelayAdmin({ rest: client(), root, now });

  const settingOf = (vault: string): RelaySetting | null => {
    const store = context?.stores.device.store ?? device;
    if (store === undefined) return null;
    try {
      return runQuery(store, relaySetting, { vault }).value;
    } catch {
      return null;
    }
  };
  const enabledOn = (setting: RelaySetting | null): setting is RelaySetting =>
    setting?.enabled === true && setting.project === endpoints.projectId;
  /** Enabled on this project here at some point (the switch may be off now). */
  const knownOn = (setting: RelaySetting | null): setting is RelaySetting =>
    setting?.project === endpoints.projectId;
  const writeSetting = async (vault: string, value: RelaySetting | null): Promise<boolean> => {
    const target = context?.stores.device;
    if (target === undefined) return false;
    const written = await target.queue.run(() =>
      target.store.run(setRelaySetting, { vault, value }),
    );
    return written.ok;
  };

  /** The reconciliation's calls wait out a running back-off like every pass (an outage is not polled). */
  const backedOff = (vault: string): void => {
    const state = vaults.get(vault);
    if (state !== undefined && state.policy.blockedUntil > now()) throw new Error("relay_backoff");
  };

  /** The data dir's identity was replaced: every enabled vault's membership is stale. */
  async function markIdentityLost(): Promise<void> {
    const target = context?.stores.device;
    if (target === undefined) return;
    try {
      const at = now();
      const all = runQuery(target.store, relaySettings, undefined).value;
      let marked = 0;
      for (const [vault, setting] of Object.entries(all)) {
        if (!setting.enabled) continue;
        await writeSetting(vault, { ...setting, identityLostAt: at });
        await refreshRecoverable(vault);
        marked += 1;
      }
      log.warn("relay.identity-lost", { vaults: marked });
    } catch (error) {
      log.warn("relay.identity-lost-unrecorded", { error: errorName(error) });
    }
  }

  /** A pass that started after the loss reached the relay cleanly: the membership works again. */
  const clearIdentityLost = async (vault: string, passStartedAt: number) => {
    const setting = settingOf(vault);
    if (setting?.identityLostAt === undefined || setting.identityLostAt >= passStartedAt) return;
    const { identityLostAt: _cleared, ...rest } = setting;
    await writeSetting(vault, rest).catch(() => false);
  };

  function scheduleRetry(vault: string, state: VaultRelay, delayMs: number): void {
    state.cancelRetry?.();
    state.cancelRetry = timers.after(Math.max(0, delayMs), () => {
      state.cancelRetry = undefined;
      request(vault, "push");
    });
  }

  /** Stops the vault's triggers at once: no pass is queued for it from now on. */
  function halt(state: VaultRelay): void {
    state.stopped = true;
    state.cancelDebounce?.();
    state.cancelRetry?.();
    state.cancelDebounce = undefined;
    state.cancelRetry = undefined;
    state.again = false;
  }

  /** After an owner action: the vault runs again only while its switch is still on. */
  function settle(vault: string, state: VaultRelay): void {
    if (!state.stopped || !enabledOn(settingOf(vault))) return;
    state.stopped = false;
    if (state.dirty) request(vault, "push");
  }

  function request(vault: string, reason: RelayPassReason): Promise<void> | undefined {
    const state = vaults.get(vault);
    // The final push runs after admission closed (the idle exit), before the stores close.
    if (state === undefined || state.stopped || closed || context === undefined) return;
    if (reason !== "final" && context.closing()) return;
    // The switch is re-read for every pass: one turned off since the open never runs again.
    if (!enabledOn(settingOf(vault))) return;
    if (state.running !== undefined) {
      if (reason !== "pull" && reason !== "watch") state.again = true;
      return state.running;
    }
    const at = state.policy.nextAt(reason, now());
    if (at > now()) {
      if (state.dirty || reason === "open") scheduleRetry(vault, state, at - now());
      return;
    }
    state.cancelRetry?.();
    state.cancelRetry = undefined;
    const running = runPass(vault, state, reason).finally(() => {
      state.running = undefined;
      if (state.again) {
        state.again = false;
        request(vault, "push");
      }
    });
    state.running = running;
    return running;
  }

  async function runPass(vault: string, state: VaultRelay, reason: RelayPassReason): Promise<void> {
    const session = context?.stores.vaults.get(vault)?.native;
    if (session === undefined) return;
    if (!session.isCurrent() && !session.isSyncing()) return;
    const startedAt = now();
    state.policy.started(startedAt);
    const owed = state.dirty;
    state.dirty = false;
    let result: Awaited<ReturnType<NativeVaultSession["sync"]>>;
    state.finalPass = reason === "final";
    try {
      result = await session.sync();
    } catch (error) {
      // The session refused or failed closed (authority): the next write, pull or open retries.
      state.dirty ||= owed;
      log.warn("relay.pass-failed", { error: errorName(error) });
      return;
    } finally {
      state.finalPass = false;
    }
    state.stuck = result.stuck;
    // Halted during the pass: its result says nothing about the relay (the gate refused).
    if (state.stopped) {
      state.dirty ||= owed;
      return;
    }
    // Judged by the transport's last call: a pass whose append failed but whose later call succeeded
    // counts as delivered; the engine re-delivers what the relay lacks on the next pass anyway.
    // The gated remote already fed the policy with every call's outcome (G4).
    const outcome = state.transport.status();
    if (outcome.lastError !== undefined) {
      state.dirty ||= owed;
      if (state.dirty) scheduleRetry(vault, state, state.policy.blockedUntil - now());
      return;
    }
    state.lastSyncAt = now();
    // S6: the push budget ended the pass early; the queue was free in between, the next pass goes on.
    if (result.pushPending) {
      state.dirty = true;
      if (reason !== "final") state.again = true;
    }
    await clearIdentityLost(vault, startedAt);
  }

  return {
    configured: true,
    projectId: endpoints.projectId,

    wrapSource(source) {
      return {
        inventory: source.inventory,
        keyStore: source.keyStore,
        sodium: source.sodium,
        bootstrapCertificates: (entry) => source.bootstrapCertificates(entry),
        ...(source.maxPushBytesPerPass === undefined
          ? {}
          : { maxPushBytesPerPass: source.maxPushBytesPerPass }),
        pullHistory(entry: NativeVaultInventoryEntry): PullHistory | undefined {
          // G2 / G5: the history kept with the relay switch; another source's otherwise. With the
          // switch off the last complete pull still bounds the offline lead (lease.ts), the pause not.
          const setting = settingOf(entry.vaultId);
          if (setting === null || setting.project !== endpoints.projectId)
            return source.pullHistory?.(entry);
          if (!setting.enabled)
            return setting.lastCompletePullAt === undefined
              ? source.pullHistory?.(entry)
              : { lastCompleteAt: setting.lastCompletePullAt };
          return {
            ...(setting.lastCompletePullAt === undefined
              ? {}
              : { lastCompleteAt: setting.lastCompletePullAt }),
            ...(setting.pausedSince === undefined ? {} : { pausedSince: setting.pausedSince }),
          };
        },
        offlineLeadAck(entry: NativeVaultInventoryEntry) {
          // A device-local fact of this Mac about the vault, on or off (the bound applies either way).
          return settingOf(entry.vaultId)?.offlineLeadAckAt;
        },
        relayRole(entry: NativeVaultInventoryEntry, device: string) {
          // G2: a device's kind is a fact about the device; any setting of the vault knows it.
          const setting = settingOf(entry.vaultId);
          return setting === null ? undefined : relayDeviceRole(setting, device);
        },
        remoteTransports(entry: NativeVaultInventoryEntry): readonly Transport[] {
          const own = source.remoteTransports?.(entry) ?? [];
          if (closed || !enabledOn(settingOf(entry.vaultId))) return own;
          const previous = vaults.get(entry.vaultId);
          if (previous !== undefined) {
            halt(previous);
            previous.unsubscribe?.();
          }
          const state: VaultRelay = {
            transport: newTransport(),
            policy: new RelayPolicy(),
            stopped: false,
            dirty: false,
            again: false,
            running: undefined,
            cancelDebounce: undefined,
            cancelRetry: undefined,
            unsubscribe: undefined,
            lastSyncAt: undefined,
            stuck: [],
            finalPass: false,
          };
          vaults.set(entry.vaultId, state);
          return [...own, gatedRemote(state)];
        },
      };
    },

    attachDevice(store) {
      device = store;
    },

    start(host) {
      context = host;
      // The reconnect action of a vault whose identity was lost in an earlier run.
      for (const [vault, setting] of Object.entries(
        runQuery(host.stores.device.store, relaySettings, undefined).value,
      ))
        if (enabledOn(setting) && setting.identityLostAt !== undefined)
          void refreshRecoverable(vault);
      for (const [vault, state] of vaults) {
        const session = host.stores.vaults.get(vault)?.native;
        if (session === undefined) continue;
        const offWrite = session.onLocalWrite(() => {
          state.dirty = true;
          state.cancelDebounce?.();
          state.cancelDebounce = timers.after(RELAY_PUSH_DEBOUNCE_MS, () => {
            state.cancelDebounce = undefined;
            request(vault, "push");
          });
        });
        // G2 / G5: after every pass of any caller, the engine's history goes to the relay switch.
        const offSettled = session.onSyncSettled(() => {
          void keepHistory(vault, session).catch((error: unknown) =>
            log.warn("relay.history-unrecorded", { error: errorName(error) }),
          );
        });
        state.unsubscribe = () => {
          offWrite();
          offSettled();
        };
        state.cancelRetry = timers.after(0, () => {
          state.cancelRetry = undefined;
          request(vault, "open");
        });
      }
      if (vaults.size > 0)
        cancelPull = timers.every(RELAY_PULL_INTERVAL_MS, () => {
          for (const vault of vaults.keys()) request(vault, "pull");
        });
    },

    pending() {
      let count = 0;
      for (const state of vaults.values())
        if (state.running !== undefined || state.cancelDebounce !== undefined) count += 1;
      return count;
    },

    async finalPush({ signal, timeoutMs = RELAY_FINAL_PUSH_TIMEOUT_MS } = {}) {
      if (signal?.aborted) return;
      const work: Promise<void>[] = [];
      for (const [vault, state] of vaults) {
        if (state.stopped) continue;
        // Own writes waiting for their debounce, a running pass or a back-off retry.
        if (
          !state.dirty &&
          state.cancelDebounce === undefined &&
          state.running === undefined &&
          state.cancelRetry === undefined
        )
          continue;
        state.cancelDebounce?.();
        state.cancelDebounce = undefined;
        work.push(
          (async () => {
            await state.running;
            if (state.dirty) await request(vault, "final");
          })(),
        );
      }
      if (work.length === 0) return;
      let cancel = () => {};
      let unlisten = () => {};
      const bound = new Promise<void>((resolve) => {
        cancel = timers.after(timeoutMs, resolve);
        if (signal === undefined) return;
        const onAbort = () => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        unlisten = () => signal.removeEventListener("abort", onAbort);
      });
      try {
        await Promise.race([Promise.allSettled(work), bound]);
      } finally {
        cancel();
        unlisten();
      }
    },

    close() {
      closed = true;
      cancelPull?.();
      for (const watch of watches.values()) watch.cancel();
      watches.clear();
      for (const state of vaults.values()) {
        halt(state);
        state.unsubscribe?.();
      }
      inFlight.abort();
    },

    status(vault) {
      const setting = settingOf(vault);
      if (!enabledOn(setting))
        return { ...HIDDEN_STATUS, configured: true, enabled: false, devices: 0 };
      const state = vaults.get(vault);
      const stuck = stuckSummary(state?.stuck ?? []);
      // An open engine knows its pause (none after a complete pull); the persisted value only stands in
      // while no session is open, so a stale one never shows "paused" after a complete pull.
      const history = historyOf(vault);
      const pausedSince = history === undefined ? setting.pausedSince : history.pausedSince;
      const quotaUntil = state?.policy.quotaUntil(now());
      const identityLost = setting.identityLostAt !== undefined;
      const failing = removalsFailing.get(vault);
      return {
        configured: true,
        enabled: true,
        devices: Object.keys(setting.memberUids).length,
        ...(state?.lastSyncAt === undefined ? {} : { lastSyncAt: state.lastSyncAt }),
        ...(pausedSince === undefined ? {} : { pausedSince }),
        ...(quotaUntil === undefined ? {} : { quotaUntil }),
        identityLost,
        canReconnect: identityLost && recoverable.get(vault) === true,
        ...(stuck === undefined ? {} : { stuck }),
        ...(failing === undefined
          ? {}
          : {
              removalsFailing: {
                devices: failing.devices,
                since: failing.since,
                ids: [...failing.ids],
              },
            }),
      };
    },

    transportStatus(vault) {
      const setting = settingOf(vault);
      let status: RelayStatus = vaults.get(vault)?.transport.status() ?? {};
      if (setting?.identityLostAt !== undefined)
        status = {
          ...status,
          lastError: "relay-identity-lost",
          lastErrorAt: Math.max(status.lastErrorAt ?? 0, setting.identityLostAt),
        };
      return status;
    },

    enable(vault) {
      return exclusive(vault, async (session) => {
        let uid: string;
        try {
          uid = await identity().uid();
        } catch {
          return refused("offline");
        }
        const admin = await becomeFirstAdmin(vault, session.device, uid);
        if (admin !== "admin") return refused(admin);
        const previous = settingOf(vault);
        const kept = knownOn(previous) ? previous : undefined;
        const written = await writeSetting(vault, {
          enabled: true,
          project: endpoints.projectId,
          enabledAt: now(),
          memberUids: { ...kept?.memberUids, [session.device]: { uid, role: "admin" } },
          ...(kept === undefined ? {} : keptRoles(kept, { [session.device]: "admin" })),
          // The last complete pull survives an off / on (the offline lead's bound).
          ...(kept?.lastCompletePullAt === undefined
            ? {}
            : { lastCompletePullAt: kept.lastCompletePullAt }),
        });
        if (!written) return refused("busy");
        // A remote halted by a disable whose reopen is still pending: reopen again with it on.
        const state = vaults.get(vault);
        return done(state === undefined || state.stopped);
      });
    },

    disable(vault) {
      return exclusive(vault, async () => {
        // Halted before anything awaits: no trigger queues a pass from here on.
        const state = vaults.get(vault);
        if (state !== undefined) halt(state);
        try {
          const previous = settingOf(vault);
          if (previous?.enabled && !(await writeSetting(vault, { ...previous, enabled: false })))
            return refused("busy");
          return done(state !== undefined);
        } finally {
          if (state !== undefined) settle(vault, state);
        }
      });
    },

    purge(vault) {
      return exclusive(vault, async (session) => {
        // Halted before anything awaits: a debounce, pull or retry firing during the purge queues no
        // pass behind it, and the engine's remote refuses every other caller until the reopen.
        const state = vaults.get(vault);
        if (state !== undefined) halt(state);
        try {
          // Serialized with this vault's passes already queued; the switch goes off first.
          return await session.queue.run(async (): Promise<RelayOutcome> => {
            const previous = settingOf(vault);
            if (previous?.enabled && !(await writeSetting(vault, { ...previous, enabled: false })))
              return refused("busy");
            const purger = newTransport();
            try {
              await purger.purge(vault);
            } catch {
              const kind = purger.status().lastError;
              // A purge that deleted something before it failed is retried, not "offline".
              const reason =
                kind === "forbidden" || kind === "relay-identity-lost"
                  ? "not_admin"
                  : purger.purgeCommits > 0
                    ? "retry"
                    : "offline";
              // The switch is off already: the remote goes with the reopen even though the purge
              // must be retried.
              return { result: refused(reason).result, reopen: state !== undefined };
            }
            // Every other member document went with the purge: only this Mac stays bound. The
            // devices' kinds stay (a phone never leads, bound or not).
            const after = settingOf(vault);
            const own = after?.memberUids[session.device];
            if (after !== null && own !== undefined)
              await writeSetting(vault, {
                ...after,
                memberUids: { [session.device]: own },
                ...keptRoles(after),
              });
            return done(state !== undefined);
          });
        } finally {
          if (state !== undefined) settle(vault, state);
        }
      });
    },

    reconnect(vault) {
      return exclusive(vault, async (session) => {
        const setting = settingOf(vault);
        if (!enabledOn(setting)) return refused("busy");
        const store = recovery();
        if (store === undefined) return refused("no_recovery_secret");
        // A cached session can name a uid the relay already replaced: the first request swaps it, and
        // the proof written for the old uid is refused. One more round under the new uid then.
        let uid = "";
        for (let round = 0; ; round += 1) {
          let record: RelayRecoveryRecord | null;
          try {
            record = await store.get(vault);
          } catch {
            return refused("offline");
          }
          if (record === null) {
            recoverable.set(vault, false);
            return refused("no_recovery_secret");
          }
          try {
            uid = await identity().uid();
          } catch {
            return refused("offline");
          }
          const recovered = await recoverWith(store, vault, record, session.device, uid);
          if (recovered === "admin") break;
          const replaced = await identity()
            .uid()
            .then((now) => now !== uid)
            .catch(() => false);
          if (recovered !== "not_admin" || !replaced || round > 0) return refused(recovered);
        }
        // The lost uids go after this Mac is admin again: every member document bound to this device
        // under another uid (the one the setting knew, and one an earlier attempt re-admitted before
        // its identity was lost again).
        try {
          const admin = relayAdmin();
          for (const member of await admin.listMembers(vault))
            if (member.device === session.device && member.uid !== uid)
              await admin.removeMember(vault, member.uid);
        } catch (error) {
          log.warn("relay.reconnect-old-member", { error: errorName(error) });
          return refused(unreachable(error) ? "retry" : "not_admin");
        }
        const current = settingOf(vault);
        if (!enabledOn(current)) return refused("busy");
        const { identityLostAt: _cleared, ...rest } = current;
        const written = await writeSetting(vault, {
          ...rest,
          memberUids: { ...rest.memberUids, [session.device]: { uid, role: "admin" } },
        });
        if (!written) return refused("retry");
        // The passes resume at once: the back-off the refusals armed is not the relay's fault.
        const state = vaults.get(vault);
        if (state !== undefined && !state.stopped) {
          state.policy.reset();
          state.dirty = true;
          request(vault, "push");
        }
        return done(false);
      });
    },

    async addMember(vault, input) {
      const setting = settingOf(vault);
      if (!enabledOn(setting)) throw new Error("relay_off");
      await relayAdmin().addMember(vault, input);
      // The membership exists from here on: a setting that cannot be written is adopted later.
      const current = settingOf(vault);
      if (!knownOn(current)) return;
      const memberUids = Object.fromEntries(
        Object.entries(current.memberUids).filter(
          ([device, entry]) => device === input.device || relayMemberUid(entry) !== input.uid,
        ),
      );
      memberUids[input.device] = { uid: input.uid, role: input.role };
      const written = await writeSetting(vault, {
        ...current,
        memberUids,
        ...keptRoles(current, { [input.device]: input.role }),
      }).catch(() => false);
      if (!written) log.warn("relay.member-unrecorded", { error: "relay_setting_unwritten" });
    },

    async removeMember(vault, device) {
      const entry = settingOf(vault)?.memberUids[device];
      if (entry === undefined) return;
      await relayAdmin().removeMember(vault, relayMemberUid(entry));
      const current = settingOf(vault);
      if (current === null) return;
      const { [device]: _removed, ...rest } = current.memberUids;
      if (!(await writeSetting(vault, { ...current, memberUids: rest, ...keptRoles(current) })))
        throw new Error("relay_setting_unwritten");
    },

    async listMembers(vault) {
      if (!knownOn(settingOf(vault))) throw new Error("relay_off");
      backedOff(vault);
      return relayAdmin().listMembers(vault);
    },

    async removeStrayMember(vault, uid) {
      if (!knownOn(settingOf(vault))) throw new Error("relay_off");
      backedOff(vault);
      await relayAdmin().removeMember(vault, uid);
      const current = settingOf(vault);
      if (!knownOn(current)) return;
      const memberUids = Object.fromEntries(
        Object.entries(current.memberUids).filter(([, entry]) => relayMemberUid(entry) !== uid),
      );
      if (Object.keys(memberUids).length === Object.keys(current.memberUids).length) return;
      if (!(await writeSetting(vault, { ...current, memberUids, ...keptRoles(current) })))
        throw new Error("relay_setting_unwritten");
    },

    async adoptMembers(vault, members, registered) {
      const target = context?.stores.device;
      if (target === undefined) return;
      await target.queue.run(() => {
        const current = runQuery(target.store, relaySetting, { vault }).value;
        if (!knownOn(current)) return;
        const memberUids = { ...current.memberUids };
        const learnt: Record<string, RelayMemberRole> = {};
        for (const member of members) {
          if (current.roles?.[member.device] !== member.role) learnt[member.device] = member.role;
          const entry = memberUids[member.device];
          if (
            entry === undefined
              ? registered.has(member.device)
              : relayMemberUid(entry) === member.uid
          )
            memberUids[member.device] = { uid: member.uid, role: member.role };
        }
        const changed =
          Object.keys(learnt).length > 0 ||
          JSON.stringify(memberUids) !== JSON.stringify(current.memberUids);
        if (!changed) return;
        target.store.run(setRelaySetting, {
          vault,
          value: { ...current, memberUids, ...keptRoles(current, learnt) },
        });
      });
    },

    async pruneExpiredPairings(vault, graceMs) {
      if (!enabledOn(settingOf(vault))) return 0;
      backedOff(vault);
      const sessions = await client().runQuery(`${root}/${vault}`, {
        collectionId: "pairings",
      });
      const at = now();
      let pruned = 0;
      for (const doc of sessions) {
        const name = client().relativeName(doc.name);
        const sessionId = name.slice(name.lastIndexOf("/") + 1);
        const field = doc.fields.expiresAt;
        const expiresAt =
          field !== undefined && "timestampValue" in field ? Date.parse(field.timestampValue) : NaN;
        if (!/^[0-9a-f]{32}$/.test(sessionId) || !(expiresAt + graceMs < at)) continue;
        await new FirestorePairingLink({
          rest: client(),
          uid: () => identity().uid(),
          vault,
          sessionId,
          side: "inviter",
          root,
          now,
        }).close();
        pruned += 1;
      }
      return pruned;
    },

    requestPull(vault) {
      void request(vault, "pull");
    },

    watchPairing(vault) {
      if (closed) return () => {};
      const entry = { at: now() + RELAY_WATCH_MAX_MS };
      let watch = watches.get(vault);
      if (watch === undefined) {
        const until = new Set<{ at: number }>();
        const created = { until, cancel: () => {} };
        created.cancel = timers.every(RELAY_WATCH_PULL_MS, () => {
          const at = now();
          for (const item of until) if (item.at <= at) until.delete(item);
          if (until.size === 0) {
            created.cancel();
            if (watches.get(vault) === created) watches.delete(vault);
            return;
          }
          void request(vault, "watch");
        });
        watches.set(vault, created);
        watch = created;
      }
      const own = watch;
      own.until.add(entry);
      return () => {
        own.until.delete(entry);
        if (own.until.size > 0) return;
        own.cancel();
        if (watches.get(vault) === own) watches.delete(vault);
      };
    },

    keepFetching(vault) {
      return exclusive(vault, async (session) => {
        const target = context?.stores.device;
        if (target === undefined) return refused("busy");
        // The host's own judgement, not the window's: offered only while the bound refuses this Mac.
        const list = await session.deviceList();
        if (list.kind !== "ready" || list.leader.paused !== "offline_too_long")
          return refused("busy");
        const at = input.now();
        const written = await target.queue.run(() => {
          const setting = runQuery(target.store, relaySetting, { vault }).value;
          if (setting === null) return "no_config" as const;
          return target.store.run(setRelaySetting, {
            vault,
            value: { ...setting, offlineLeadAckAt: at },
          }).ok
            ? ("written" as const)
            : ("failed" as const);
        });
        if (written === "no_config") return refused("no_config");
        if (written === "failed") return refused("busy");
        // A local pass re-reads the lease; its settle pushes the device list without the pause.
        void session.sync().catch(() => {});
        return done(false);
      });
    },

    syncNow(vault) {
      if (!enabledOn(settingOf(vault))) return Promise.resolve(refused("no_config"));
      const state = vaults.get(vault);
      if (state === undefined || state.stopped) return Promise.resolve(refused("busy"));
      if (state.policy.blockedUntil > now()) return Promise.resolve(refused("offline"));
      return (request(vault, "push") ?? Promise.resolve()).then(
        () => done(false),
        () => refused("offline"),
      );
    },

    noteRemovalsFailing(vault, failing) {
      if (failing === undefined) removalsFailing.delete(vault);
      else removalsFailing.set(vault, failing);
    },

    pairingLink(vault, sessionId) {
      if (!enabledOn(settingOf(vault))) throw new Error("relay_off");
      return new FirestorePairingLink({
        rest: client(),
        uid: () => identity().uid(),
        vault,
        sessionId,
        side: "inviter",
        root,
        now,
      });
    },
  };

  /**
   * Makes this Mac the vault's first admin at the relay (or confirms it already is) under the vault's
   * recovery secret, created and stored in the keychain before the commit that writes its hash.
   */
  async function becomeFirstAdmin(
    vault: string,
    device: string,
    uid: string,
  ): Promise<"admin" | "not_admin" | "offline"> {
    const store = recovery();
    let record: RelayRecoveryRecord | null = null;
    let created = false;
    if (store !== undefined) {
      try {
        record = await store.get(vault);
        if (record === null) {
          record = { current: newRecoverySecret() };
          await store.set(vault, record);
          created = true;
        }
      } catch {
        return "offline";
      }
    }
    const admin = relayAdmin();
    try {
      const outcome = await admin.createVault(vault, {
        uid,
        device,
        ...(record === null ? {} : { recoveryHash: relayRecoveryHash(record.current) }),
      });
      if (outcome === "taken") {
        // Never reached the relay: a secret made for this call must not offer a reconnect.
        if (created) await store?.clear(vault).catch(() => {});
        return "not_admin";
      }
      if (store !== undefined && record !== null) {
        // Already admin (a re-enable, or a vault created before secrets were kept): the relay's hash
        // is pinned to the kept secret, so a pending `next` or a missing hash never outlives this.
        if (outcome === "already-admin")
          await admin.recoverAdmin(vault, {
            uid,
            device,
            proof: record.current,
            nextRecoveryHash: relayRecoveryHash(record.current),
          });
        if (record.next !== undefined) await store.set(vault, { current: record.current });
      }
      recoverable.set(vault, record !== null);
      return "admin";
    } catch (error) {
      return unreachable(error) ? "offline" : "not_admin";
    }
  }

  /**
   * Re-admits `uid` with the kept secret. The record holds one secret, or two while a recovery is not
   * confirmed (the relay holds the hash of one of them): it tries `current` -> `next`, then `next` ->
   * `current`, so whichever the relay holds, both stay in the keychain until one is confirmed. A
   * record with one secret gets its `next` stored before the commit.
   */
  async function recoverWith(
    store: RelayRecoverySecrets,
    vault: string,
    kept: RelayRecoveryRecord,
    device: string,
    uid: string,
  ): Promise<"admin" | "not_admin" | "offline"> {
    let record = kept;
    if (record.next === undefined) {
      record = { current: record.current, next: newRecoverySecret() };
      try {
        await store.set(vault, record);
      } catch {
        return "offline";
      }
    }
    const { current, next } = record as Required<RelayRecoveryRecord>;
    const admin = relayAdmin();
    for (const [proof, after] of [
      [current, next],
      [next, current],
    ] as const) {
      try {
        const outcome = await admin.recoverAdmin(vault, {
          uid,
          device,
          proof,
          nextRecoveryHash: relayRecoveryHash(after),
        });
        if (outcome === "refused") continue;
      } catch (error) {
        return unreachable(error) ? "offline" : "not_admin";
      }
      // Confirmed: the relay holds `after`'s hash. A keychain write that fails here keeps both.
      await store.set(vault, { current: after }).catch(() => {});
      recoverable.set(vault, true);
      return "admin";
    }
    return "not_admin";
  }

  /**
   * The engine's remote of one vault: the Firestore transport behind a gate that answers
   * `unavailable` while the relay has not started (safe mode never starts it), after `close`, and
   * while the vault is halted. S6: while a back-off runs it also answers `unavailable` at once, for
   * every caller (a bank sync's or the UI's pass never waits out the relay's timeouts in the vault
   * queue); only the final push goes through. The back-off answer carries the reason of the failure
   * that started it: only an outage lets the engine count the remote unreachable (D6); a refusal
   * (this Mac removed, its identity lost) keeps the pass incomplete (G1). G4: every call that does
   * reach the relay feeds the policy, whoever runs the pass, so the first failed call of any pass
   * arms the back-off for every later caller. A halted gate is the host's own choice: an outage.
   */
  function gatedRemote(state: VaultRelay): Transport {
    const { transport } = state;
    const open = (): void => {
      if (state.stopped || closed || context === undefined)
        throw new TransportError("unavailable", "relay_halted", "outage");
      if (!state.finalPass && state.policy.blockedUntil > now())
        throw new TransportError("unavailable", "relay_backoff", state.policy.blockedReason);
    };
    // Reads and writes are judged apart (policy.ts): a list that works never cancels the back-off of
    // appends that keep timing out.
    const observe = async <T>(direction: RelayDirection, call: () => Promise<T>): Promise<T> => {
      open();
      try {
        const result = await call();
        state.policy.succeeded(direction);
        return result;
      } catch (error) {
        if (error instanceof TransportError && error.code === "unavailable") {
          const kind = transport.status().lastError;
          state.policy.failed(
            kind === "quota" ? "quota" : "unavailable",
            now(),
            error.reason,
            direction,
          );
        } else if (error instanceof TransportError) {
          // An offset conflict is an answer: the relay is there.
          state.policy.succeeded(direction);
        }
        throw error;
      }
    };
    return {
      consistency: transport.consistency,
      list: (vault) => observe("read", () => transport.list(vault)),
      read: (vault, device, seg, fromOffset) =>
        observe("read", () => transport.read(vault, device, seg, fromOffset)),
      append: (vault, device, seg, atOffset, bytes) =>
        observe("write", () => transport.append(vault, device, seg, atOffset, bytes)),
    };
  }

  /** The engine's sync history of an open vault (G2 / G5); undefined when none is open. */
  function historyOf(vault: string): PullHistory | undefined {
    const session = context?.stores.vaults.get(vault)?.native;
    try {
      return session?.engine.pullHistory();
    } catch {
      return undefined;
    }
  }

  /**
   * Persists the engine's history into the vault's relay switch, read and written inside the device
   * queue (a disable in between is never undone), only while the switch is on, and only when the
   * pause changed or the last complete pull moved by HISTORY_WRITE_STEP_MS (not a write per pass).
   */
  async function keepHistory(vault: string, session: NativeVaultSession): Promise<void> {
    const target = context?.stores.device;
    if (target === undefined || closed) return;
    const history = session.engine.pullHistory();
    await target.queue.run(() => {
      const setting = runQuery(target.store, relaySetting, { vault }).value;
      if (!enabledOn(setting)) return;
      const last = history.lastCompleteAt ?? setting.lastCompletePullAt;
      const lastMoved =
        last !== setting.lastCompletePullAt &&
        (setting.lastCompletePullAt === undefined ||
          last === undefined ||
          Math.abs(last - setting.lastCompletePullAt) >= HISTORY_WRITE_STEP_MS);
      // G2 override: a complete pull since the owner's acknowledgement ends it (asked again next time).
      const ack = setting.offlineLeadAckAt;
      const ackCleared =
        ack !== undefined && history.lastCompleteAt !== undefined && history.lastCompleteAt >= ack;
      if (!lastMoved && !ackCleared && history.pausedSince === setting.pausedSince) return;
      const {
        lastCompletePullAt: _last,
        pausedSince: _paused,
        offlineLeadAckAt: _ack,
        ...rest
      } = setting;
      target.store.run(setRelaySetting, {
        vault,
        value: {
          ...rest,
          ...(last === undefined ? {} : { lastCompletePullAt: last }),
          ...(history.pausedSince === undefined ? {} : { pausedSince: history.pausedSince }),
          ...(ack === undefined || ackCleared ? {} : { offlineLeadAckAt: ack }),
        },
      });
    });
  }

  /** One owner action per vault at a time, on an open native vault of this host. */
  async function exclusive(
    vault: string,
    run: (session: NativeVaultSession) => Promise<RelayOutcome>,
  ): Promise<RelayOutcome> {
    const session = context?.stores.vaults.get(vault)?.native;
    if (session === undefined || closed || context?.closing() || busy.has(vault))
      return refused("busy");
    busy.add(vault);
    try {
      return await run(session);
    } catch (error) {
      log.warn("relay.action-failed", { error: errorName(error) });
      return refused("busy");
    } finally {
      busy.delete(vault);
    }
  }
}
