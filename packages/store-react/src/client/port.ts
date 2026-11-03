// The asynchronous adapter: the desktop renderer talks to the local host over a MessagePort that
// Electron main relays into its `ui` session (store channel v2, @cashu/host-protocol/store). A query is
// subscribed by id (the host runs it and pushes a snapshot after every change that touched its tables),
// so the first read waits one hop and `useQuery` suspends once; commands go by id with an idempotency
// key minted once per command, and come back as their result union, or as a `RemoteStoreError` for an
// unexpected failure.
//
// The host can go away while the window is open (killed, crashed, replaced by an update). Main then
// says so with `link` messages and reconnects (starting a host when none answers). Meanwhile the
// snapshots stay as they are (stale) and new subscriptions and commands wait. When the new session
// announces itself (`ready`), every live subscription is sent again and every command still waiting
// for its answer is sent again with the same key: the host answers a command it already committed from
// its request table, so a command is never lost and never applied twice.

import {
  decodeValue,
  type JsonValue,
  type LinkState,
  type RelayToClient,
  relayToClientSchema,
  STORE_PROTOCOL_VERSION,
  type StoreToHost,
  toJson,
} from "@cashu/host-protocol/store";
import type { CommandResult } from "@cashu/store";
import { mintUlid } from "@cashu/store";
import type { UiActionResult } from "@cashu/store/ui-actions";
import { type CacheOptions, QueryCache } from "./cache.js";
import { ConnectionState, type ConnectionStatus } from "./connection.js";
import { RemoteStoreError } from "./errors.js";
import type { Adapter, Channel, Sink } from "./types.js";

export interface PortClientOptions extends Omit<CacheOptions, "async" | "connection"> {
  readonly uiPrivacy?: { getSnapshot(): boolean; subscribe(listener: () => void): () => void };
  /**
   * A message from the relay that does not validate (a version skew or a bug). Default: thrown from
   * the message handler, where the renderer's global error handler records it.
   */
  readonly onProtocolError?: (error: unknown) => void;
  /** How long `recovered` is shown after the host came back, before `online` (default 4 s). */
  readonly recoveredMs?: number;
  /** Mints a command's idempotency key (default: a ULID of now). */
  readonly mintKey?: () => string;
  /**
   * Every status change, also before the client exists (the first connect may have to start the
   * host); React code reads `useConnection()` instead.
   */
  readonly onStatus?: (status: ConnectionStatus) => void;
}

const DEFAULT_RECOVERED_MS = 4_000;

const LINK_STATUS: Readonly<Record<Exclude<LinkState, "connected">, ConnectionStatus>> = {
  connecting: "connecting",
  starting: "starting",
  unavailable: "unavailable",
};

type Run = Extract<StoreToHost, { t: "run" }>;
type Sub = Extract<StoreToHost, { t: "sub" }>;

/** Connect through the relay; resolves once the host announced itself (`ready`). */
export function createPortClient(
  channel: Channel,
  options: PortClientOptions = {},
): Promise<QueryCache> {
  const onProtocolError =
    options.onProtocolError ??
    ((error: unknown) => {
      throw error;
    });
  const mintKey = options.mintKey ?? (() => mintUlid(Date.now()));
  const recoveredMs = options.recoveredMs ?? DEFAULT_RECOVERED_MS;
  const connection = new ConnectionState("connecting");
  if (options.onStatus) connection.subscribe(() => options.onStatus?.(connection.getSnapshot()));

  const subs = new Map<number, { readonly sink: Sink; readonly message: Sub }>();
  const runs = new Map<
    number,
    {
      readonly message: Run;
      resolve(r: CommandResult<unknown>): void;
      reject(e: unknown): void;
    }
  >();
  const actions = new Map<number, (result: UiActionResult<unknown>) => void>();
  let nextId = 0;
  /** True between a session's `ready` and the next link loss: only then do messages go out. */
  let live = false;
  let lost = false;
  let recoveredTimer: ReturnType<typeof setTimeout> | undefined;
  let privacy = options.uiPrivacy?.getSnapshot() ?? true;
  let policyGeneration = 0;
  let client: QueryCache | null = null;
  const post = (message: StoreToHost) => {
    if (live) channel.post(message);
  };
  const sendPolicy = () => post({ t: "uiPolicy", generation: policyGeneration, privacy });
  const stopPrivacy = options.uiPrivacy?.subscribe(() => {
    const current = options.uiPrivacy?.getSnapshot() ?? true;
    if (current === privacy) return;
    privacy = current;
    policyGeneration += 1;
    const existing = [...subs.entries()];
    const interrupted = [...actions.values()];
    actions.clear();
    for (const resolve of interrupted)
      resolve({ status: "outcome_unknown", reason: "interrupted" });
    sendPolicy();
    client?.resetSnapshots();
    for (const [sid, subscription] of existing) {
      if (subs.get(sid) !== subscription) continue;
      const message: Sub = { ...subscription.message, generation: policyGeneration, resume: true };
      subs.set(sid, { sink: subscription.sink, message });
      post(message);
    }
  });

  const onLink = (state: LinkState) => {
    if (state === "connected") return; // the session's `ready` follows
    if (live) lost = true;
    live = false;
    for (const resolve of actions.values())
      resolve({ status: "outcome_unknown", reason: "interrupted" });
    actions.clear();
    clearTimeout(recoveredTimer);
    connection.set(LINK_STATUS[state]);
  };

  return new Promise((resolveClient) => {
    const onReady = (vaults: readonly string[]) => {
      live = true;
      if (client !== null) policyGeneration += 1;
      sendPolicy();
      if (client === null) {
        connection.set("online");
        const adapter: Adapter = {
          dispose() {
            stopPrivacy?.();
            for (const resolve of actions.values())
              resolve({ status: "outcome_unknown", reason: "interrupted" });
            actions.clear();
          },
          vaults,
          invoke(target, action, input) {
            if (!live) return Promise.resolve({ status: "not_started", reason: "disconnected" });
            if (target.kind !== "vault")
              return Promise.resolve({
                status: "refused",
                reason: "invalid_target",
                preparation: "none",
              });
            const payload = toJson(input);
            const rid = nextId++;
            return new Promise((resolve) => {
              actions.set(rid, resolve);
              try {
                post({ t: "action", rid, target, action: action.id, input: payload });
              } catch {
                actions.delete(rid);
                resolve({ status: "outcome_unknown", reason: "unexpected_failure" });
              }
            });
          },
          open(target, query, args, sink) {
            const sid = nextId++;
            const message: Sub = {
              t: "sub",
              sid,
              generation: policyGeneration,
              resume: false,
              target,
              query: query.id,
              args: toJson(args),
            };
            subs.set(sid, { sink, message });
            post(message);
            return () => {
              if (subs.delete(sid)) post({ t: "unsub", sid });
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
            const message: Run = {
              t: "run",
              rid,
              key: mintKey(),
              target,
              command: command.id,
              input: payload,
            };
            return new Promise((resolve, reject) => {
              runs.set(rid, { message, resolve, reject });
              post(message);
            });
          },
        };
        client = new QueryCache(adapter, { ...options, async: true, connection });
        resolveClient(client);
        return;
      }
      // A new session (the host came back, or a new host took over): it knows nothing of ours.
      const existing = [...subs.entries()];
      client.resetSnapshots();
      for (const [sid, subscription] of existing) {
        if (subs.get(sid) !== subscription) continue;
        const message: Sub = {
          ...subscription.message,
          generation: policyGeneration,
          resume: true,
        };
        subs.set(sid, { sink: subscription.sink, message });
        post(message);
      }
      for (const { message } of runs.values()) post(message);
      if (lost) {
        lost = false;
        connection.set("recovered");
        recoveredTimer = setTimeout(() => connection.set("online"), recoveredMs);
      } else {
        connection.set("online");
      }
    };

    const handle = (message: RelayToClient): void => {
      switch (message.t) {
        case "actionResult": {
          const resolve = actions.get(message.rid);
          actions.delete(message.rid);
          const result = message.result;
          resolve?.(
            result.status === "completed"
              ? { status: "completed", value: decodeValue(result.value) }
              : result,
          );
          return;
        }
        case "link":
          onLink(message.state);
          return;
        case "ready":
          onReady(message.vaults);
          return;
        case "value":
          if (message.generation === policyGeneration)
            subs.get(message.sid)?.sink.value(decodeValue(message.value));
          return;
        case "error":
          if (message.generation === policyGeneration)
            subs.get(message.sid)?.sink.error(new RemoteStoreError(message.error));
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
      const parsed = relayToClientSchema.safeParse(raw);
      if (!parsed.success) {
        onProtocolError(
          new Error(`invalid store channel message (protocol ${STORE_PROTOCOL_VERSION})`),
        );
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
