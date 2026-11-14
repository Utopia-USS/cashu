// The sync relay on the Mac host (M4-C sections 1 and 2): per vault, an owner switch on this device
// (`relay.<vaultId>` in the device store, default off) that adds the Firestore transport as a remote of
// the vault's engine, and the triggers that run its passes:
//   - at vault open (a first full push after enabling),
//   - 2 s after own writes (debounced, coalescing),
//   - every 5 minutes while the host runs (a pull at most every 60 s),
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
// `identityLostAt` (the status reports `relay-identity-lost` until a pass reaches the relay again).
import type { RelayActionResult, RelayStatusResult } from "@cashu/host-protocol";
import type { HostLock } from "@cashu/node-host";
import {
  type DeviceStore,
  type RelaySetting,
  relaySetting,
  relaySettings,
  setRelaySetting,
} from "@cashu/store/device";
import { runQuery } from "@cashu/store/query";
import {
  type AnonymousAuth,
  type AuthStore,
  FirestoreRest,
  FirestoreRestError,
  FirestoreTransport,
  type PullHistory,
  type RelayStatus,
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
  type RelayDirection,
  type RelayPassReason,
  RelayPolicy,
} from "./policy.js";

const DEFAULT_ROOT = "vaults";
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
  status(vault: string): RelayStatusResult;
  enable(vault: string): Promise<RelayOutcome>;
  disable(vault: string): Promise<RelayOutcome>;
  purge(vault: string): Promise<RelayOutcome>;
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

/** D7: the value-free status summary of the engine's stuck records. */
function stuckSummary(records: readonly StuckRecord[]): RelayStatusResult["stuck"] {
  if (records.length === 0) return undefined;
  const open = records.filter((r) => r.kind !== "final");
  const oldest = open.reduce<StuckRecord | undefined>(
    (best, r) => (best === undefined || r.firstSeenAt < best.firstSeenAt ? r : best),
    undefined,
  );
  return {
    waiting: records.filter((r) => r.kind === "waiting").length,
    rejected: records.filter((r) => r.kind === "rejected").length,
    final: records.filter((r) => r.kind === "final").length,
    ...(oldest === undefined ? {} : { since: oldest.firstSeenAt }),
    passes: open.reduce((most, r) => Math.max(most, r.passes), 0),
  };
}

const done = (reopen: boolean): RelayOutcome => ({ result: { kind: "done" }, reopen });
const refused = (
  reason: Extract<RelayActionResult, { kind: "refused" }>["reason"],
): RelayOutcome => ({ result: { kind: "refused", reason }, reopen: false });

/** The relay of a host without a config: nothing is wired, every action is refused `no_config`. */
function unconfiguredRelay(): HostRelay {
  return {
    configured: false,
    wrapSource: (source) => source,
    attachDevice() {},
    start() {},
    pending: () => 0,
    finalPush: () => Promise.resolve(),
    close() {},
    status: () => ({ configured: false, enabled: false, status: {}, devices: 0 }),
    enable: () => Promise.resolve(refused("no_config")),
    disable: () => Promise.resolve(refused("no_config")),
    purge: () => Promise.resolve(refused("no_config")),
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
  let device: DeviceStore | undefined;
  let context: RelayHostContext | undefined;
  let closed = false;
  let cancelPull: (() => void) | undefined;
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
  const writeSetting = async (vault: string, value: RelaySetting | null): Promise<boolean> => {
    const target = context?.stores.device;
    if (target === undefined) return false;
    const written = await target.queue.run(() =>
      target.store.run(setRelaySetting, { vault, value }),
    );
    return written.ok;
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
      if (reason !== "pull") state.again = true;
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
          // G2 / G5: the history kept with the relay switch; another source's otherwise.
          const setting = settingOf(entry.vaultId);
          if (!enabledOn(setting)) return source.pullHistory?.(entry);
          return {
            ...(setting.lastCompletePullAt === undefined
              ? {}
              : { lastCompleteAt: setting.lastCompletePullAt }),
            ...(setting.pausedSince === undefined ? {} : { pausedSince: setting.pausedSince }),
          };
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
      for (const state of vaults.values()) {
        halt(state);
        state.unsubscribe?.();
      }
      inFlight.abort();
    },

    status(vault) {
      const setting = settingOf(vault);
      const enabled = enabledOn(setting);
      const state = vaults.get(vault);
      let status: RelayStatus = state?.transport.status() ?? {};
      if (setting?.identityLostAt !== undefined)
        status = {
          ...status,
          lastError: "relay-identity-lost",
          lastErrorAt: Math.max(status.lastErrorAt ?? 0, setting.identityLostAt),
        };
      const stuck = stuckSummary(state?.stuck ?? []);
      // An open engine knows its pause (none after a complete pull); the persisted value only stands in
      // while no session is open, so a stale one never shows "paused" after a complete pull.
      const history = historyOf(vault);
      const pausedSince = history === undefined ? setting?.pausedSince : history.pausedSince;
      return {
        configured: true,
        enabled,
        status,
        devices: enabled ? Object.keys(setting.memberUids).length : 0,
        ...(state?.lastSyncAt === undefined ? {} : { lastSyncAt: state.lastSyncAt }),
        ...(enabled && pausedSince !== undefined ? { pausedSince } : {}),
        ...(enabled && stuck !== undefined ? { stuck } : {}),
      };
    },

    enable(vault) {
      return exclusive(vault, async (session) => {
        let uid: string;
        try {
          uid = await identity().uid();
        } catch {
          return refused("offline");
        }
        const admin = await createVaultAtRelay(client(), root, vault, session.device, uid, now());
        if (admin !== "admin") return refused(admin);
        const previous = settingOf(vault);
        const written = await writeSetting(vault, {
          enabled: true,
          project: endpoints.projectId,
          enabledAt: now(),
          memberUids: {
            ...(previous?.project === endpoints.projectId ? previous.memberUids : {}),
            [session.device]: uid,
          },
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
            return done(state !== undefined);
          });
        } finally {
          if (state !== undefined) settle(vault, state);
        }
      });
    },
  };

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
      if (!lastMoved && history.pausedSince === setting.pausedSince) return;
      const { lastCompletePullAt: _last, pausedSince: _paused, ...rest } = setting;
      target.store.run(setRelaySetting, {
        vault,
        value: {
          ...rest,
          ...(last === undefined ? {} : { lastCompletePullAt: last }),
          ...(history.pausedSince === undefined ? {} : { pausedSince: history.pausedSince }),
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

/**
 * Makes this Mac the vault's first admin at the relay, or confirms it already is: the vault document
 * `{ createdAt, admins: [uid] }` and the member document `members/{uid}` `{ device, role: "admin",
 * addedAt }` in one commit (the rules' bootstrap: the vault must not exist yet).
 * TRANSITIONAL(S28d): replaced by `FirestoreRelayAdmin.createVault` of @cashu/sync (C2).
 */
async function createVaultAtRelay(
  rest: FirestoreRest,
  root: string,
  vault: string,
  device: string,
  uid: string,
  at: number,
): Promise<"admin" | "not_admin" | "offline"> {
  const vaultDoc = `${root}/${vault}`;
  const memberDoc = `${vaultDoc}/members/${uid}`;
  const offline = (error: unknown) =>
    !(error instanceof FirestoreRestError) ||
    error.code === "unavailable" ||
    error.code === "resource-exhausted" ||
    error.code === "unauthenticated";
  /** This uid's member document as the relay holds it now (undefined: none, or not readable). */
  const membership = async (): Promise<"admin" | "not_admin" | "offline" | undefined> => {
    try {
      const member = await rest.get(memberDoc);
      if (member === undefined) return undefined;
      const role = member.fields.role;
      const bound = member.fields.device;
      return role !== undefined &&
        "stringValue" in role &&
        role.stringValue === "admin" &&
        bound !== undefined &&
        "stringValue" in bound &&
        bound.stringValue === device
        ? "admin"
        : "not_admin";
    } catch (error) {
      // A non-member may not read a member document (the rules answer 403 whether or not it exists).
      return offline(error) ? "offline" : undefined;
    }
  };
  const existing = await membership();
  if (existing !== undefined) return existing;
  const timestamp = { timestampValue: new Date(at).toISOString() };
  try {
    await rest.commit([
      {
        update: {
          name: vaultDoc,
          fields: {
            createdAt: timestamp,
            admins: { arrayValue: { values: [{ stringValue: uid }] } },
          },
        },
        currentDocument: { exists: false },
      },
      {
        update: {
          name: memberDoc,
          fields: {
            device: { stringValue: device },
            role: { stringValue: "admin" },
            addedAt: timestamp,
          },
        },
        currentDocument: { exists: false },
      },
    ]);
    return "admin";
  } catch (error) {
    if (offline(error)) return "offline";
    // A retried commit whose first response was lost finds the documents it wrote itself: read the
    // membership again before answering. Otherwise the vault exists and this uid is not its admin
    // (another Mac created it, or this Mac's identity was replaced): only an admin can add it.
    const after = await membership();
    return after === "admin" ? "admin" : after === "offline" ? "offline" : "not_admin";
  }
}
