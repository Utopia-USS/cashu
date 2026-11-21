// The asynchronous adapter: the desktop renderer talks to the local host over a MessagePort that
// Electron main relays into its `ui` session (store channel v5, @cashu/host-protocol/store). A query is
// subscribed by id (the host runs it and pushes a snapshot after every change that touched its tables).
// Commands settle on interruption and retain only an opaque in-memory attempt for read-only lookup.
//
// The host can go away while the window is open (killed, crashed, replaced by an update). Main then
// says so with `link` messages and reconnects (starting a host when none answers). Meanwhile the
// snapshots stay as they are (stale); offline commands return not_started. On ready, live queries
// resubscribe. An uncertain command is never automatically submitted again.

import {
  decodeValue,
  type LinkState,
  type RelayToClient,
  type RunOutcomeWire,
  relayToClientSchema,
  STORE_PROTOCOL_VERSION,
  type StoreToHost,
  toJson,
} from "@cashu/host-protocol/store";
import { currentVault } from "@cashu/store/device";
import type { UiActionResult } from "@cashu/store/ui-actions";
import { type CacheOptions, QueryCache } from "./cache.js";
import { ConnectionState, type ConnectionStatus } from "./connection.js";
import { RemoteStoreError } from "./errors.js";
import type { Adapter, Channel, CommandAttempt, CommandOutcome, Sink } from "./types.js";

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
type Lookup = Extract<StoreToHost, { t: "lookup" }>;
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
  const recoveredMs = options.recoveredMs ?? DEFAULT_RECOVERED_MS;
  const connection = new ConnectionState("connecting");
  if (options.onStatus) connection.subscribe(() => options.onStatus?.(connection.getSnapshot()));

  const subs = new Map<number, { readonly sink: Sink; readonly message: Sub }>();
  const runs = new Map<
    number,
    {
      readonly attempt: CommandAttempt;
      readonly generation: number;
      resolve(r: CommandOutcome<unknown>): void;
    }
  >();
  const lookups = new Map<
    number,
    {
      readonly attempt: CommandAttempt;
      readonly generation: number;
      resolve(r: CommandOutcome<unknown>): void;
    }
  >();
  const actions = new Map<number, (result: UiActionResult<unknown>) => void>();
  let nextId = 0;
  /** True between a session's `ready` and the next link loss: only then do messages go out. */
  let live = false;
  let lost = false;
  let recoveredTimer: ReturnType<typeof setTimeout> | undefined;
  let privacy = options.uiPrivacy?.getSnapshot() ?? false;
  let policyGeneration = 0;
  let currentVaults: readonly string[] = [];
  let selectedVault: string | null | undefined;
  let client: QueryCache | null = null;
  let disposed = false;
  let stopChannel: (() => void) | undefined;
  const unknown = (attempt: CommandAttempt, attemptId?: string): CommandOutcome<unknown> => ({
    kind: "outcome_unknown",
    key: attempt.key,
    attempt,
    ...(attemptId ? { attemptId } : {}),
  });
  const interrupt = () => {
    for (const pending of runs.values()) pending.resolve(unknown(pending.attempt));
    for (const pending of lookups.values()) pending.resolve(unknown(pending.attempt));
    runs.clear();
    lookups.clear();
  };
  const selectVault = (vault: string | null) => {
    if (selectedVault === vault) return;
    selectedVault = vault;
    for (const [rid, pending] of runs) {
      if (pending.attempt.target.kind !== "vault" || pending.attempt.target.vault === vault)
        continue;
      runs.delete(rid);
      pending.resolve(unknown(pending.attempt));
    }
    for (const [rid, pending] of lookups) {
      if (pending.attempt.target.kind !== "vault" || pending.attempt.target.vault === vault)
        continue;
      lookups.delete(rid);
      pending.resolve(unknown(pending.attempt));
    }
  };
  const post = (message: StoreToHost) => {
    if (live) channel.post(message);
  };
  const sendPolicy = () => post({ t: "uiPolicy", generation: policyGeneration, privacy });
  const stopPrivacy = options.uiPrivacy?.subscribe(() => {
    const current = options.uiPrivacy?.getSnapshot() ?? true;
    if (current === privacy) return;
    privacy = current;
    policyGeneration += 1;
    interrupt();
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
    interrupt();
    for (const resolve of actions.values())
      resolve({ status: "outcome_unknown", reason: "interrupted" });
    actions.clear();
    clearTimeout(recoveredTimer);
    connection.set(LINK_STATUS[state]);
  };

  return new Promise((resolveClient) => {
    const onReady = (vaults: readonly string[]) => {
      if (client !== null) interrupt();
      currentVaults = vaults;
      selectedVault = undefined;
      live = true;
      if (client !== null) policyGeneration += 1;
      sendPolicy();
      if (client === null) {
        connection.set("online");
        const adapter: Adapter = {
          dispose() {
            if (disposed) return;
            disposed = true;
            live = false;
            stopPrivacy?.();
            stopChannel?.();
            clearTimeout(recoveredTimer);
            interrupt();
            subs.clear();
            for (const resolve of actions.values())
              resolve({ status: "outcome_unknown", reason: "interrupted" });
            actions.clear();
          },
          get vaults() {
            return currentVaults;
          },
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
          run(target, command, input, attempt) {
            if (!live || disposed)
              return Promise.resolve({ kind: "not_started", reason: "disconnected" });
            if (
              attempt.command !== command.id ||
              attempt.target.kind !== target.kind ||
              (attempt.target.kind === "vault" &&
                target.kind === "vault" &&
                attempt.target.vault !== target.vault)
            )
              return Promise.resolve({ kind: "refused", reason: "attempt_scope_mismatch" });
            let payload: Run["input"];
            try {
              payload = toJson(input);
            } catch {
              return Promise.resolve({ kind: "refused", reason: "unsupported_input" });
            }
            const rid = nextId++;
            const message: Run = {
              t: "run",
              rid,
              generation: policyGeneration,
              key: attempt.key,
              target: attempt.target,
              command: attempt.command,
              input: payload,
            };
            return new Promise((resolve) => {
              runs.set(rid, { attempt, generation: policyGeneration, resolve });
              try {
                post(message);
              } catch {
                runs.delete(rid);
                resolve(unknown(attempt));
              }
            });
          },
          reconcile(attempt) {
            if (!live || disposed || privacy) return Promise.resolve(unknown(attempt));
            if (attempt.target.kind === "vault" && !currentVaults.includes(attempt.target.vault))
              return Promise.resolve(unknown(attempt));
            if (
              attempt.target.kind === "vault" &&
              selectedVault === undefined &&
              [...subs.values()].some(
                (subscription) => subscription.message.query === currentVault.id,
              )
            )
              return Promise.resolve(unknown(attempt));
            if (
              attempt.target.kind === "vault" &&
              selectedVault !== undefined &&
              selectedVault !== attempt.target.vault
            )
              return Promise.resolve(unknown(attempt));
            const rid = nextId++;
            const message: Lookup = {
              t: "lookup",
              rid,
              generation: policyGeneration,
              key: attempt.key,
              target: attempt.target,
              command: attempt.command,
            };
            return new Promise((resolve) => {
              lookups.set(rid, { attempt, generation: policyGeneration, resolve });
              try {
                post(message);
              } catch {
                lookups.delete(rid);
                resolve(unknown(attempt));
              }
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
      if (lost) {
        lost = false;
        connection.set("recovered");
        recoveredTimer = setTimeout(() => connection.set("online"), recoveredMs);
      } else {
        connection.set("online");
      }
    };

    const decodeOutcome = (
      outcome: RunOutcomeWire,
      attempt: CommandAttempt,
    ): CommandOutcome<unknown> => {
      switch (outcome.kind) {
        case "completed":
          return { kind: "completed", value: decodeValue(outcome.value) };
        case "refused":
        case "not_started":
          return outcome;
        case "outcome_unknown":
          return unknown(attempt, outcome.attemptId);
      }
    };
    const handle = (message: RelayToClient): void => {
      if (disposed) return;
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
          if (message.generation === policyGeneration) {
            const subscription = subs.get(message.sid);
            if (subscription !== undefined) {
              const value = decodeValue(message.value);
              if (
                subscription.message.query === currentVault.id &&
                (value === null || typeof value === "string")
              )
                selectVault(value);
              subscription.sink.value(value);
            }
          }
          return;
        case "error":
          if (message.generation === policyGeneration)
            subs.get(message.sid)?.sink.error(new RemoteStoreError(message.error));
          return;
        case "result": {
          const pending = runs.get(message.rid);
          runs.delete(message.rid);
          if (pending) {
            if (
              message.generation !== pending.generation ||
              message.generation !== policyGeneration ||
              !live ||
              privacy
            )
              pending.resolve(unknown(pending.attempt));
            else {
              try {
                pending.resolve(decodeOutcome(message.outcome, pending.attempt));
              } catch {
                pending.resolve(unknown(pending.attempt));
              }
            }
          }
          return;
        }
        case "lookupResult": {
          const pending = lookups.get(message.rid);
          lookups.delete(message.rid);
          if (pending) {
            if (
              message.generation !== pending.generation ||
              message.generation !== policyGeneration ||
              !live ||
              privacy
            )
              pending.resolve(unknown(pending.attempt));
            else {
              try {
                pending.resolve(decodeOutcome(message.outcome, pending.attempt));
              } catch {
                pending.resolve(unknown(pending.attempt));
              }
            }
          }
          return;
        }
        case "failed": {
          const pending = runs.get(message.rid);
          runs.delete(message.rid);
          if (pending)
            pending.resolve(
              message.generation === pending.generation && live
                ? { kind: "not_started", reason: "preinvoke_failure" }
                : unknown(pending.attempt),
            );
          return;
        }
      }
    };
    stopChannel = channel.listen((raw) => {
      const parsed = relayToClientSchema.safeParse(raw);
      if (!parsed.success) {
        interrupt();
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
