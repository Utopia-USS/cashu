// The asynchronous adapter: the desktop renderer talks to the store process over a MessagePort. A
// query is subscribed by id (the store process runs it and pushes a snapshot after every change that
// touched its tables), so the first read waits one hop and `useQuery` suspends once; commands go by id
// and come back as their result union, or as a `RemoteStoreError` for an unexpected failure.
import type { CommandResult } from "@cashu/store";
import {
  decodeValue,
  type JsonValue,
  PROTOCOL_VERSION,
  RemoteStoreError,
  type ToClient,
  type ToHost,
  toClientSchema,
  toJson,
} from "../protocol/index.js";
import { type CacheOptions, QueryCache } from "./cache.js";
import type { Adapter, Channel, Sink } from "./types.js";

export interface PortClientOptions extends Omit<CacheOptions, "async"> {
  /**
   * A message from the store process that does not validate (a version skew or a bug). Default:
   * thrown from the message handler, where the renderer's global error handler records it.
   */
  readonly onProtocolError?: (error: unknown) => void;
}

/** Connect to a store process; resolves once it announced itself (`ready`). */
export function createPortClient(
  channel: Channel,
  options: PortClientOptions = {},
): Promise<QueryCache> {
  const onProtocolError =
    options.onProtocolError ??
    ((error: unknown) => {
      throw error;
    });
  const subs = new Map<number, Sink>();
  const runs = new Map<
    number,
    { resolve(r: CommandResult<unknown>): void; reject(e: unknown): void }
  >();
  let nextId = 0;
  const post = (message: ToHost) => channel.post(message);

  return new Promise((resolveClient) => {
    let client: QueryCache | null = null;
    const handle = (message: ToClient): void => {
      switch (message.t) {
        case "ready": {
          if (client !== null) return;
          const adapter: Adapter = {
            vaults: message.vaults,
            open(target, query, args, sink) {
              const sid = nextId++;
              subs.set(sid, sink);
              post({ t: "sub", sid, target, query: query.id, args: toJson(args) });
              return () => {
                subs.delete(sid);
                post({ t: "unsub", sid });
              };
            },
            run(target, command, input) {
              const rid = nextId++;
              let payload: JsonValue;
              try {
                payload = toJson(input);
              } catch (error) {
                return Promise.reject(error);
              }
              return new Promise((resolve, reject) => {
                runs.set(rid, { resolve, reject });
                post({ t: "run", rid, target, command: command.id, input: payload });
              });
            },
          };
          client = new QueryCache(adapter, { ...options, async: true });
          resolveClient(client);
          return;
        }
        case "value":
          subs.get(message.sid)?.value(decodeValue(message.value));
          return;
        case "error":
          subs.get(message.sid)?.error(new RemoteStoreError(message.error));
          return;
        case "result": {
          const pending = runs.get(message.rid);
          runs.delete(message.rid);
          pending?.resolve(
            message.result.ok
              ? { ok: true, value: decodeValue(message.result.value) }
              : { ok: false, reason: message.result.reason },
          );
          return;
        }
        case "failed": {
          const pending = runs.get(message.rid);
          runs.delete(message.rid);
          pending?.reject(new RemoteStoreError(message.error));
          return;
        }
      }
    };
    channel.listen((raw) => {
      const parsed = toClientSchema.safeParse(raw);
      if (!parsed.success) {
        onProtocolError(new Error(`invalid store port message (protocol ${PROTOCOL_VERSION})`));
        return;
      }
      try {
        handle(parsed.data);
      } catch (error) {
        onProtocolError(error);
      }
    });
  });
}
