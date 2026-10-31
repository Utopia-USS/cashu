// The store process side of the port: serves the registered queries and commands of this device's
// stores to one renderer. Every message is validated (the sandboxed renderer is not trusted); only
// registered queries / commands run; a live query pushes a new snapshot only when its encoded value
// changed. Platform free: the desktop store process passes its MessagePortMain as a `Channel`.
import type { Query, QueryArgs } from "@cashu/store/query";
import { watchQuery } from "@cashu/store/query";
import { deepEqual } from "../client/structural.js";
import type { AnyCommand, Channel } from "../client/types.js";
import { type LocalStores, runLocal, sourceFor } from "../local/stores.js";
import {
  encodeValue,
  errorInfo,
  PROTOCOL_VERSION,
  type ToClient,
  type ToHost,
  toHostSchema,
} from "../protocol/index.js";

export interface StoreHostOptions extends LocalStores {
  /** The queries the renderer may subscribe to, by id. */
  readonly queries: readonly Query<QueryArgs, unknown>[];
  /** The commands the renderer may run, by id. */
  readonly commands: readonly AnyCommand[];
  /** Unexpected failures and invalid messages, for the local log (never values). */
  readonly onError?: (error: unknown, context: string) => void;
}

function byId<T extends { readonly id: string }>(
  items: readonly T[],
  kind: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`two ${kind} registered as ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

/** Serve `channel` until the returned function is called (it stops every live query). */
export function serveStore(channel: Channel, options: StoreHostOptions): () => void {
  const queries = byId(options.queries, "queries");
  const commands = byId(options.commands, "commands");
  const report = options.onError ?? (() => {});
  const live = new Map<number, () => void>();
  const post = (message: ToClient) => channel.post(message);

  const subscribe = (message: Extract<ToHost, { t: "sub" }>): void => {
    live.get(message.sid)?.();
    const query = queries.get(message.query);
    if (query === undefined) {
      post({
        t: "error",
        sid: message.sid,
        error: { name: "UnknownQuery", message: message.query },
      });
      return;
    }
    let last: { readonly encoded: unknown } | null = null;
    const fail = (error: unknown) => {
      last = null;
      report(error, `query ${query.id}`);
      post({ t: "error", sid: message.sid, error: errorInfo(error) });
    };
    try {
      const source = sourceFor(options, message.target, query);
      const stop = watchQuery(source, query, message.args as QueryArgs, {
        onValue(value) {
          let encoded: unknown;
          try {
            encoded = encodeValue(value);
          } catch (error) {
            fail(error);
            return;
          }
          if (last !== null && deepEqual(last.encoded, encoded)) return;
          last = { encoded };
          post({ t: "value", sid: message.sid, value: encoded });
        },
        onError: fail,
      });
      live.set(message.sid, stop);
    } catch (error) {
      fail(error);
    }
  };

  const run = (message: Extract<ToHost, { t: "run" }>): void => {
    const command = commands.get(message.command);
    if (command === undefined) {
      post({
        t: "failed",
        rid: message.rid,
        error: { name: "UnknownCommand", message: message.command },
      });
      return;
    }
    try {
      const result = runLocal(options, message.target, command, message.input);
      post({
        t: "result",
        rid: message.rid,
        result: result.ok
          ? { ok: true, value: encodeValue(result.value) }
          : { ok: false, reason: result.reason },
      });
    } catch (error) {
      report(error, `command ${command.id}`);
      post({ t: "failed", rid: message.rid, error: errorInfo(error) });
    }
  };

  const stopListening = channel.listen((raw) => {
    const parsed = toHostSchema.safeParse(raw);
    if (!parsed.success) {
      report(new Error("invalid store port message"), "protocol");
      return;
    }
    const message = parsed.data;
    switch (message.t) {
      case "sub":
        subscribe(message);
        return;
      case "unsub":
        live.get(message.sid)?.();
        live.delete(message.sid);
        return;
      case "run":
        run(message);
        return;
    }
  });
  post({ t: "ready", protocol: PROTOCOL_VERSION, vaults: [...options.vaults.keys()] });

  return () => {
    stopListening();
    for (const stop of live.values()) stop();
    live.clear();
  };
}
