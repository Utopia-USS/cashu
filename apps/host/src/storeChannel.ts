// The store channel v3 of one `ui` session (`@cashu/host-protocol/store` in `store` frames): live
// queries pushed on change, keyed commands through the target's write queue. Only registered query /
// command ids run; a vault target must be open on this host; every message is validated (the renderer
// is not trusted). A snapshot is pushed only when its encoded value changed. A session may have at
// most `maxInFlight` commands waiting; more are failed as `Busy`. When the session closes its live
// queries stop; a command already queued still runs (and is recorded), its reply is dropped.

import {
  encodeValue,
  errorInfo,
  STORE_PROTOCOL_VERSION,
  type StoreTarget,
  type StoreToClient,
  type StoreToHost,
  storeToHostSchema,
} from "@cashu/host-protocol/store";
import type { HostSession } from "@cashu/node-host";
import type { Query, QueryArgs, QuerySource } from "@cashu/store/query";
import { watchQuery } from "@cashu/store/query";
import { type KeyedRun, runDeviceCommand, runVaultCommand } from "./commands.js";
import { errorName, type HostLog } from "./log.js";
import { type AnyCommand, isDeviceCommand } from "./registry.js";
import type { HostStores, OpenDevice, OpenVault } from "./stores.js";
import type { UiActionRegistration } from "./uiActions.js";

export interface StoreChannelOptions {
  /** Exact UI-role host RPCs, separate from store channel v5. */
  readonly onRequest?: (
    frame: Extract<import("@cashu/host-protocol").ClientFrame, { t: "req" }>,
  ) => void;
  /** Classifies prose-bearing document reads; policy can only refuse private delivery. */
  readonly privateQuery?: (query: string, args: QueryArgs) => boolean;
  readonly actions?: readonly UiActionRegistration[];
  readonly prepareQuery?: (vault: string, query: string, args: QueryArgs) => Promise<void>;
  readonly stores: HostStores;
  readonly queries: readonly Query<QueryArgs, unknown>[];
  readonly commands: readonly AnyCommand[];
  readonly log: HostLog;
  readonly maxInFlight?: number;
  /** Called after a command's transaction committed, before its reply is sent (fault tests). */
  readonly afterCommit?: () => void;
}

const DEFAULT_MAX_IN_FLIGHT = 64;

function byId<T extends { readonly id: string }>(items: readonly T[]): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`two registrations of ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownTargetError";
  }
}

type Target = StoreTarget;

/** Serves the store channel on `session` (role `ui`). */
export function serveStoreChannel(session: HostSession, options: StoreChannelOptions): void {
  const queries = byId(options.queries);
  const commands = byId(options.commands);
  const actions = byId(options.actions ?? []);
  const { stores, log } = options;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const live = new Map<number, () => void>();
  const liveMessages = new Map<number, Extract<StoreToHost, { t: "sub" }>>();
  /** The encoded value last pushed per sid, kept across a sync-settled re-subscribe so an unchanged
   * result is not sent again; a client `sub` or any error frame of the sid starts it over. */
  const lastPushed = new Map<number, string>();
  const syncHooks = new Map<OpenVault, () => void>();
  const preparing = new Map<number, object>();
  const actionRequests = new Map<number, string>();
  let highestActionRid = -1;
  let inFlight = 0;
  let closed = false;
  let policy: { readonly generation: number; readonly privacy: boolean } | null = null;
  const post = (m: StoreToClient) => {
    if (m.t === "error") lastPushed.delete(m.sid);
    if (!closed) session.send({ t: "store", m });
  };

  const vaultOf = (target: Target): OpenVault => {
    if (target.kind !== "vault") throw new TargetError("a vault target is required");
    const vault = stores.vaults.get(target.vault);
    if (vault === undefined) throw new TargetError("this vault is not open on this host");
    if (vault.native !== undefined && !vault.native.isCurrent())
      throw new TargetError("this vault is no longer admitted");
    return vault;
  };
  const sourceFor = (target: Target, query: Query<QueryArgs, unknown>): QuerySource => {
    if (query.scope !== target.kind) {
      throw new TargetError(`a ${query.scope} query cannot read the ${target.kind} store`);
    }
    return target.kind === "device" ? stores.device.store : vaultOf(target).store;
  };

  /** Re-subscribe this vault's live queries when a native sync pass settles (once per vault, also
   * for a vault first targeted after the session started). */
  const hookSync = (vault: OpenVault) => {
    if (vault.native === undefined || syncHooks.has(vault)) return;
    syncHooks.set(
      vault,
      vault.native.onSyncSettled(() => {
        if (closed) return;
        for (const message of [...liveMessages.values()]) {
          if (message.target.kind === "vault" && message.target.vault === vault.id)
            subscribe(message, false, false);
        }
      }),
    );
  };

  const subscribe = (m: Extract<StoreToHost, { t: "sub" }>, prepared = false, fresh = true) => {
    if (policy === null || m.generation !== policy.generation) return;
    liveMessages.set(m.sid, m);
    if (fresh) lastPushed.delete(m.sid);
    live.get(m.sid)?.();
    live.delete(m.sid);
    if (!prepared) preparing.delete(m.sid);
    if (m.target.kind === "vault") {
      const vault = stores.vaults.get(m.target.vault);
      if (vault !== undefined) hookSync(vault);
    }
    const query = queries.get(m.query);
    if (query === undefined) {
      post({
        t: "error",
        sid: m.sid,
        generation: m.generation,
        error: { name: "UnknownQuery", message: m.query },
      });
      return;
    }
    let privateRead = false;
    try {
      sourceFor(m.target, query);
      privateRead = options.privateQuery?.(query.id, m.args as QueryArgs) ?? false;
    } catch {
      post({
        t: "error",
        sid: m.sid,
        generation: m.generation,
        error: { name: "UnknownTarget", message: "query target is unavailable" },
      });
      return;
    }
    if (privateRead && (policy === null || policy.privacy)) {
      if (!m.resume)
        post({
          t: "error",
          sid: m.sid,
          generation: m.generation,
          error: { name: "PrivacyRestricted", message: "private query is unavailable" },
        });
      return;
    }
    const policyAtStart = m.generation;
    if (!prepared && options.prepareQuery && m.target.kind === "vault") {
      if (inFlight >= maxInFlight) {
        post({
          t: "error",
          sid: m.sid,
          generation: m.generation,
          error: { name: "Busy", message: "too many requests" },
        });
        return;
      }
      const generation = {};
      const vault = vaultOf(m.target);
      preparing.set(m.sid, generation);
      const prepare = options.prepareQuery;
      const targetId = m.target.vault;
      inFlight += 1;
      Promise.resolve()
        .then(() => prepare(targetId, query.id, m.args as QueryArgs))
        .then(
          () => {
            if (
              closed ||
              policy?.generation !== policyAtStart ||
              preparing.get(m.sid) !== generation ||
              stores.vaults.get(vault.id) !== vault
            )
              return;
            preparing.delete(m.sid);
            subscribe(m, true, false);
          },
          () => {
            if (closed || preparing.get(m.sid) !== generation) return;
            preparing.delete(m.sid);
            post({
              t: "error",
              sid: m.sid,
              generation: m.generation,
              error: { name: "QueryPreparationFailed", message: "query preparation failed" },
            });
          },
        )
        .finally(() => {
          inFlight -= 1;
        });
      return;
    }
    const fail = (error: unknown) => {
      if (policy?.generation !== policyAtStart) return;
      if (m.target.kind === "vault" && stores.vaults.get(m.target.vault)?.native?.isSyncing())
        return;
      log.warn("store.query.failed", { query: query.id, error: errorName(error) });
      post({ t: "error", sid: m.sid, generation: m.generation, error: errorInfo(error) });
    };
    try {
      const stop = watchQuery(sourceFor(m.target, query), query, m.args as QueryArgs, {
        onValue(value) {
          if (policy?.generation !== policyAtStart) return;
          if (m.target.kind === "vault") {
            if (stores.vaults.get(m.target.vault)?.native?.isSyncing()) return;
            try {
              vaultOf(m.target);
            } catch {
              fail(new TargetError("query target is unavailable"));
              live.get(m.sid)?.();
              live.delete(m.sid);
              return;
            }
          }
          let encoded: ReturnType<typeof encodeValue>;
          try {
            encoded = encodeValue(value);
          } catch (error) {
            fail(error);
            return;
          }
          const text = JSON.stringify(encoded);
          if (text === lastPushed.get(m.sid)) return;
          lastPushed.set(m.sid, text);
          post({ t: "value", sid: m.sid, generation: m.generation, value: encoded });
        },
        onError: fail,
      });
      live.set(m.sid, stop);
    } catch (error) {
      fail(error);
    }
  };

  const action = (m: Extract<StoreToHost, { t: "action" }>) => {
    const handler = actions.get(m.action);
    const refuse = (reason: string) =>
      post({
        t: "actionResult",
        rid: m.rid,
        result: { status: "refused", reason, preparation: "none" },
      });
    if (handler === undefined) {
      refuse("unknown_action");
      return;
    }
    if (policy === null || policy.privacy) {
      refuse("privacy_restricted");
      return;
    }
    const policyAtStart = policy.generation;
    const fingerprint = JSON.stringify([m.target, m.action, m.input]);
    const prior = actionRequests.get(m.rid);
    if (prior !== undefined) {
      if (prior !== fingerprint) refuse("request_reused");
      return;
    }
    if (m.rid <= highestActionRid) {
      refuse("request_reused");
      return;
    }
    if (inFlight >= maxInFlight) {
      refuse("busy");
      return;
    }
    actionRequests.set(m.rid, fingerprint);
    highestActionRid = m.rid;
    inFlight += 1;
    Promise.resolve()
      .then(() =>
        handler.run(
          stores,
          m.target.vault,
          m.input,
          () => !closed && policy?.generation === policyAtStart && !policy.privacy,
        ),
      )
      .then((result) => {
        if (policy?.generation !== policyAtStart) {
          post({
            t: "actionResult",
            rid: m.rid,
            result: { status: "outcome_unknown", reason: "interrupted" },
          });
          return;
        }
        post({
          t: "actionResult",
          rid: m.rid,
          result:
            result.status === "completed"
              ? { status: "completed", value: encodeValue(result.value) }
              : result,
        });
      })
      .catch(() => {
        log.warn("store.action.failed", { action: m.action });
        post({
          t: "actionResult",
          rid: m.rid,
          result: { status: "outcome_unknown", reason: "unexpected_failure" },
        });
      })
      .finally(() => {
        inFlight -= 1;
        actionRequests.delete(m.rid);
      });
  };

  const run = (m: Extract<StoreToHost, { t: "run" }>) => {
    if (policy === null || policy.privacy || policy.generation !== m.generation) {
      post({
        t: "result",
        rid: m.rid,
        generation: m.generation,
        outcome: { kind: "not_started", reason: "policy_unavailable" },
      });
      return;
    }
    const command = commands.get(m.command);
    if (command === undefined) {
      post({
        t: "failed",
        rid: m.rid,
        generation: m.generation,
        error: { name: "UnknownCommand", message: m.command },
      });
      return;
    }
    if (inFlight >= maxInFlight) {
      post({
        t: "failed",
        rid: m.rid,
        generation: m.generation,
        error: { name: "Busy", message: "too many commands" },
      });
      return;
    }
    if (command.id === "device.setCurrentVault") {
      const requested = (m.input as { vault?: unknown } | null)?.vault;
      if (requested !== null && (typeof requested !== "string" || !stores.vaults.has(requested))) {
        post({
          t: "result",
          rid: m.rid,
          generation: m.generation,
          outcome: { kind: "refused", reason: "unknown_target" },
        });
        return;
      }
    }
    let target: OpenVault | OpenDevice;
    let task: () => KeyedRun | Promise<KeyedRun>;
    try {
      if (isDeviceCommand(command)) {
        if (m.target.kind !== "device")
          throw new TargetError("a device command writes the device store");
        const device = stores.device;
        target = device;
        task = () => runDeviceCommand(device, command, m.input, m.key);
      } else {
        const vault = vaultOf(m.target);
        target = vault;
        task = () => runVaultCommand(vault, command, m.input, m.key);
      }
    } catch (error) {
      post({ t: "failed", rid: m.rid, generation: m.generation, error: errorInfo(error) });
      return;
    }
    inFlight += 1;
    const execution =
      target === stores.device || ("mode" in target && target.mode === "synthetic")
        ? target.queue.run(task)
        : Promise.resolve().then(task);
    execution
      .then((done) => {
        if (!("kind" in done.result) || done.result.kind === "completed") options.afterCommit?.();
        return done;
      })
      .then(
        ({ result, replayed }) => {
          if (replayed) log.info("store.command.replayed", { command: command.id });
          const outcome =
            "kind" in result
              ? result.kind === "completed"
                ? { kind: "completed" as const, value: result.value }
                : result.kind === "outcome_unknown"
                  ? {
                      kind: "outcome_unknown" as const,
                      ...(result.attemptId === undefined ? {} : { attemptId: result.attemptId }),
                    }
                  : { kind: result.kind, reason: result.reason }
              : result.ok
                ? { kind: "completed" as const, value: result.value }
                : { kind: "refused" as const, reason: result.reason };
          post({ t: "result", rid: m.rid, generation: m.generation, outcome });
        },
        (error: unknown) => {
          log.warn("store.command.failed", { command: command.id, error: errorName(error) });
          post({
            t: "result",
            rid: m.rid,
            generation: m.generation,
            outcome:
              error instanceof Error && error.name === "KeyReusedError"
                ? { kind: "refused", reason: "request_key_conflict" }
                : { kind: "outcome_unknown" },
          });
        },
      )
      .finally(() => {
        inFlight -= 1;
      });
  };

  const lookup = (m: Extract<StoreToHost, { t: "lookup" }>) => {
    if (policy === null || policy.privacy || policy.generation !== m.generation) {
      post({
        t: "lookupResult",
        rid: m.rid,
        generation: m.generation,
        outcome: { kind: "outcome_unknown" },
      });
      return;
    }
    let outcome: Extract<StoreToClient, { t: "lookupResult" }>["outcome"];
    try {
      const target = m.target.kind === "device" ? stores.device : vaultOf(m.target);
      if ("native" in target && target.native !== undefined) {
        const status = target.native.attempts.status(target.id, m.key, m.command);
        outcome =
          status.phase === "absent"
            ? { kind: "outcome_unknown" }
            : status.phase === "terminal"
              ? status.result
              : status.phase === "completed" && status.receipt !== undefined
                ? { kind: "completed", value: status.receipt.value }
                : { kind: "outcome_unknown", attemptId: status.attemptId };
      } else {
        const prior = target.requests.lookup(m.key);
        outcome =
          prior === undefined
            ? { kind: "outcome_unknown" }
            : prior.command !== m.command
              ? { kind: "refused", reason: "request_key_conflict" }
              : prior.result.ok
                ? { kind: "completed", value: prior.result.value }
                : { kind: "refused", reason: prior.result.reason };
      }
    } catch {
      outcome = { kind: "outcome_unknown" };
    }
    post({ t: "lookupResult", rid: m.rid, generation: m.generation, outcome });
  };

  session.onFrame((frame) => {
    if (frame.t === "req" && options.onRequest !== undefined) {
      options.onRequest(frame);
      return;
    }
    if (frame.t !== "store") {
      session.close();
      return;
    }
    const parsed = storeToHostSchema.safeParse(frame.m);
    if (!parsed.success) {
      log.warn("store.invalid-message");
      session.close();
      return;
    }
    const m = parsed.data;
    switch (m.t) {
      case "uiPolicy":
        if (policy !== null && m.generation <= policy.generation) return;
        policy = { generation: m.generation, privacy: m.privacy };
        preparing.clear();
        return;
      case "sub":
        subscribe(m);
        return;
      case "unsub":
        liveMessages.delete(m.sid);
        lastPushed.delete(m.sid);
        preparing.delete(m.sid);
        live.get(m.sid)?.();
        live.delete(m.sid);
        return;
      case "run":
        run(m);
        return;
      case "lookup":
        lookup(m);
        return;
      case "action":
        action(m);
        return;
    }
  });
  session.onClose(() => {
    closed = true;
    for (const stop of syncHooks.values()) stop();
    syncHooks.clear();
    lastPushed.clear();
    for (const stop of live.values()) stop();
    live.clear();
    liveMessages.clear();
    preparing.clear();
  });
  post({ t: "ready", protocol: STORE_PROTOCOL_VERSION, vaults: [...stores.vaults.keys()] });
}
