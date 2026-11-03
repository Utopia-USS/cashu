// Test kit: an in-memory stand-in for the local host's store channel v2 (the real one is apps/host
// storeChannel.ts, which a package cannot import) and for Electron main's relay in front of it. The
// host serves real in-memory stores (memory.ts) and keeps `key -> result` like the host's request
// table, so a re-sent command is answered from it. The relay can be cut (main lost the host) and
// restored (a new session announces itself), as when the host is killed while the window is open.
// Every message crosses as JSON text, as on the host socket. Synthetic data only.
import {
  encodeValue,
  errorInfo,
  type JsonValue,
  type LinkState,
  STORE_PROTOCOL_VERSION,
  type StoreToClient,
  type StoreToHost,
  storeToHostSchema,
} from "@cashu/host-protocol/store";
import type { CommandResult } from "@cashu/store";
import type { Query, QueryArgs } from "@cashu/store/query";
import { watchQuery } from "@cashu/store/query";
import type { AnyCommand, Channel } from "../client/types.js";
import { type LocalStores, runLocal, sourceFor } from "../local/stores.js";

type RunResult = Extract<StoreToClient, { t: "result" }>["result"];

export interface TestHostOptions {
  readonly stores: LocalStores;
  readonly queries: readonly Query<QueryArgs, unknown>[];
  readonly commands: readonly AnyCommand[];
  /** Unexpected failures and invalid messages (never values). */
  readonly onError?: (error: unknown, context: string) => void;
}

/** One host session: what it receives, and how it stops (its live queries end). */
interface Session {
  receive(message: unknown): void;
  stop(): void;
}

export class TestHost {
  /** The request table: idempotency key -> stored result. */
  readonly keys = new Map<string, { readonly command: string; readonly result: RunResult }>();
  /** Commands that ran (a replay from `keys` does not count). */
  applied = 0;
  /** Set to cut the relay right after the next command committed, before its reply goes out. */
  dieAfterNextCommit: (() => void) | null = null;
  readonly #queries: ReadonlyMap<string, Query<QueryArgs, unknown>>;
  readonly #commands: ReadonlyMap<string, AnyCommand>;

  constructor(private readonly options: TestHostOptions) {
    this.#queries = new Map(options.queries.map((q) => [q.id, q]));
    this.#commands = new Map(options.commands.map((c) => [c.id, c]));
  }

  /** Opens a session that answers through `send`; it announces itself with `ready` at once. */
  session(send: (message: StoreToClient) => void): Session {
    const report = this.options.onError ?? (() => {});
    const live = new Map<number, () => void>();
    let stopped = false;
    const post = (message: StoreToClient) => {
      if (!stopped) send(message);
    };

    const subscribe = (m: Extract<StoreToHost, { t: "sub" }>) => {
      live.get(m.sid)?.();
      const query = this.#queries.get(m.query);
      if (query === undefined) {
        post({
          t: "error",
          sid: m.sid,
          generation: m.generation,
          error: { name: "UnknownQuery", message: m.query },
        });
        return;
      }
      let last: string | undefined;
      const fail = (error: unknown) => {
        last = undefined;
        report(error, `query ${query.id}`);
        post({ t: "error", sid: m.sid, generation: m.generation, error: errorInfo(error) });
      };
      try {
        const stop = watchQuery(
          sourceFor(this.options.stores, m.target, query),
          query,
          m.args as QueryArgs,
          {
            onValue(value) {
              let encoded: JsonValue;
              try {
                encoded = encodeValue(value);
              } catch (error) {
                fail(error);
                return;
              }
              const text = JSON.stringify(encoded);
              if (text === last) return;
              last = text;
              post({ t: "value", sid: m.sid, generation: m.generation, value: encoded });
            },
            onError: fail,
          },
        );
        live.set(m.sid, stop);
      } catch (error) {
        fail(error);
      }
    };

    const run = (m: Extract<StoreToHost, { t: "run" }>) => {
      const command = this.#commands.get(m.command);
      if (command === undefined) {
        post({ t: "failed", rid: m.rid, error: { name: "UnknownCommand", message: m.command } });
        return;
      }
      const prior = this.keys.get(m.key);
      if (prior !== undefined) {
        post({ t: "result", rid: m.rid, result: prior.result });
        return;
      }
      let outcome: CommandResult<unknown>;
      try {
        outcome = runLocal(this.options.stores, m.target, command, m.input);
      } catch (error) {
        report(error, `command ${command.id}`);
        post({ t: "failed", rid: m.rid, error: errorInfo(error) });
        return;
      }
      const result: RunResult = outcome.ok
        ? { ok: true, value: encodeValue(outcome.value) }
        : { ok: false, reason: outcome.reason };
      this.keys.set(m.key, { command: command.id, result });
      this.applied += 1;
      const die = this.dieAfterNextCommit;
      if (die !== null) {
        this.dieAfterNextCommit = null;
        die();
        return;
      }
      post({ t: "result", rid: m.rid, result });
    };

    send({
      t: "ready",
      protocol: STORE_PROTOCOL_VERSION,
      vaults: [...this.options.stores.vaults.keys()],
    });
    return {
      receive(raw) {
        if (stopped) return;
        const parsed = storeToHostSchema.safeParse(raw);
        if (!parsed.success) {
          report(new Error("invalid store channel message"), "protocol");
          return;
        }
        const m = parsed.data;
        if (m.t === "sub") subscribe(m);
        else if (m.t === "run") run(m);
        else if (m.t === "unsub") {
          live.get(m.sid)?.();
          live.delete(m.sid);
        } else if (m.t === "action") {
          post({
            t: "actionResult",
            rid: m.rid,
            result: { status: "refused", reason: "capability_unavailable", preparation: "none" },
          });
        }
      },
      stop() {
        stopped = true;
        for (const stop of live.values()) stop();
        live.clear();
      },
    };
  }
}

const throughJson = (message: unknown): unknown => JSON.parse(JSON.stringify(message));

/** Electron main's relay between a renderer's port and a host session, under the test's control. */
export interface TestRelay {
  /** The renderer's end, for `createPortClient`. */
  readonly client: Channel;
  /** Every store message the client posted (also those dropped while the link was down). */
  readonly sent: unknown[];
  /** Main lost the host: the session stops, the client is told `state`; messages are dropped. */
  cut(state?: Exclude<LinkState, "connected">): void;
  /** Tells the client another link state while down (e.g. `starting`). */
  link(state: Exclude<LinkState, "connected">): void;
  /** A host answers again: `connected`, then the new session's `ready`. */
  restore(): void;
  close(): void;
}

/** A relay already connected to `host` (the client receives `ready` once it listens). */
export function testRelay(host: TestHost): TestRelay {
  const sent: unknown[] = [];
  let listener: ((message: unknown) => void) | null = null;
  const backlog: unknown[] = [];
  let session: Session | null = null;
  let closed = false;
  const toClient = (message: unknown) => {
    const copy = throughJson(message);
    queueMicrotask(() => {
      if (closed) return;
      if (listener === null) backlog.push(copy);
      else listener(copy);
    });
  };
  const open = () => {
    session = host.session(toClient);
  };
  open();
  return {
    client: {
      post(message) {
        sent.push(message);
        const target = session;
        if (target === null) return; // dropped: the client re-sends after the next `ready`
        const copy = throughJson(message);
        queueMicrotask(() => {
          if (session === target) target.receive(copy);
        });
      },
      listen(handler) {
        listener = handler;
        for (const message of backlog.splice(0)) handler(message);
        return () => {
          listener = null;
        };
      },
    },
    sent,
    cut(state = "connecting") {
      session?.stop();
      session = null;
      toClient({ t: "link", state });
    },
    link(state) {
      toClient({ t: "link", state });
    },
    restore() {
      toClient({ t: "link", state: "connected" });
      open();
    },
    close() {
      closed = true;
      session?.stop();
      session = null;
    },
  };
}
