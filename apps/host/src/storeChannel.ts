// The store channel v2 of one `ui` session (`@cashu/host-protocol/store` in `store` frames): live
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

export interface StoreChannelOptions {
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
  const { stores, log } = options;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const live = new Map<number, () => void>();
  let inFlight = 0;
  let closed = false;
  const post = (m: StoreToClient) => {
    if (!closed) session.send({ t: "store", m });
  };

  const vaultOf = (target: Target): OpenVault => {
    if (target.kind !== "vault") throw new TargetError("a vault target is required");
    const vault = stores.vaults.get(target.vault);
    if (vault === undefined) throw new TargetError("this vault is not open on this host");
    return vault;
  };
  const sourceFor = (target: Target, query: Query<QueryArgs, unknown>): QuerySource => {
    if (query.scope !== target.kind) {
      throw new TargetError(`a ${query.scope} query cannot read the ${target.kind} store`);
    }
    return target.kind === "device" ? stores.device.store : vaultOf(target).store;
  };

  const subscribe = (m: Extract<StoreToHost, { t: "sub" }>) => {
    live.get(m.sid)?.();
    live.delete(m.sid);
    const query = queries.get(m.query);
    if (query === undefined) {
      post({ t: "error", sid: m.sid, error: { name: "UnknownQuery", message: m.query } });
      return;
    }
    let last: string | undefined;
    const fail = (error: unknown) => {
      last = undefined;
      log.warn("store.query.failed", { query: query.id, error: errorName(error) });
      post({ t: "error", sid: m.sid, error: errorInfo(error) });
    };
    try {
      const stop = watchQuery(sourceFor(m.target, query), query, m.args as QueryArgs, {
        onValue(value) {
          let encoded: ReturnType<typeof encodeValue>;
          try {
            encoded = encodeValue(value);
          } catch (error) {
            fail(error);
            return;
          }
          const text = JSON.stringify(encoded);
          if (text === last) return;
          last = text;
          post({ t: "value", sid: m.sid, value: encoded });
        },
        onError: fail,
      });
      live.set(m.sid, stop);
    } catch (error) {
      fail(error);
    }
  };

  const run = (m: Extract<StoreToHost, { t: "run" }>) => {
    const command = commands.get(m.command);
    if (command === undefined) {
      post({ t: "failed", rid: m.rid, error: { name: "UnknownCommand", message: m.command } });
      return;
    }
    if (inFlight >= maxInFlight) {
      post({ t: "failed", rid: m.rid, error: { name: "Busy", message: "too many commands" } });
      return;
    }
    let target: OpenVault | OpenDevice;
    let task: () => KeyedRun;
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
      post({ t: "failed", rid: m.rid, error: errorInfo(error) });
      return;
    }
    inFlight += 1;
    target.queue
      .run(() => {
        const done = task();
        options.afterCommit?.();
        return done;
      })
      .then(
        ({ result, replayed }) => {
          if (replayed) log.info("store.command.replayed", { command: command.id });
          post({ t: "result", rid: m.rid, result });
        },
        (error: unknown) => {
          log.warn("store.command.failed", { command: command.id, error: errorName(error) });
          post({ t: "failed", rid: m.rid, error: errorInfo(error) });
        },
      )
      .finally(() => {
        inFlight -= 1;
      });
  };

  session.onFrame((frame) => {
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
      case "sub":
        subscribe(m);
        return;
      case "unsub":
        live.get(m.sid)?.();
        live.delete(m.sid);
        return;
      case "run":
        run(m);
        return;
    }
  });
  session.onClose(() => {
    closed = true;
    for (const stop of live.values()) stop();
    live.clear();
  });
  post({ t: "ready", protocol: STORE_PROTOCOL_VERSION, vaults: [...stores.vaults.keys()] });
}
