/// <reference types="node" />
// Electron main's side of the renderer's store channel (layers.md "Which process runs what"): one
// `ui` session on the local host per renderer frame, relayed without parsing. What the renderer posts on
// its MessagePort goes into `store` frames as it is; the host's `store` frames go back as their `m`.
// Main never reads store data, never opens a store and holds no keys.
//
// Toward the renderer main adds `link` messages (@cashu/host-protocol/store relay.ts): `connecting`
// while it connects, `starting` when no host answered and it started one, `connected` once a session
// is up (the host's own store `ready` follows), `unavailable` when the host could not be reached or
// started (retried with backoff). When the host goes away (killed, crashed, replaced by an update) the
// relay reconnects on its own; store messages posted meanwhile are dropped, and the renderer's client
// re-sends its live queries and unanswered commands (same idempotency keys) after the new `ready`.
//
// Electron's MessagePortMain and the host connection come in through small interfaces, so the
// lifecycle is testable without Electron or a host process.
import type { ClientFrame, HostFrame } from "@cashu/host-protocol";
import type { JsonValue, LinkMessage, LinkState } from "@cashu/host-protocol/store";

/** Main's end of the renderer's MessagePort (`MessageChannelMain().port1`). */
export interface RelayPort {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  /** The renderer's end went away (the page navigated, reloaded or closed). */
  onClose(handler: () => void): void;
  close(): void;
}

/** The part of a `HostConnection` (@cashu/node-host) the relay uses. */
export interface RelayConnection {
  send(frame: ClientFrame): void;
  onFrame(handler: (frame: HostFrame) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface HostRelayOptions {
  readonly port: RelayPort;
  /**
   * Connect to the data dir's host as a `ui` client, or start one and wait for it (`connectOrStart`);
   * `onStarting` is called when it starts a host.
   */
  connect(onStarting: () => void): Promise<RelayConnection>;
  /** Value-free lines for the shell's log. */
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
  /** Backoff between failed connects: from `initial` doubling to `max` (default 500 ms to 10 s). */
  readonly retryMs?: { readonly initial: number; readonly max: number };
}

const DEFAULT_RETRY = { initial: 500, max: 10_000 } as const;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HostRelay {
  readonly #options: HostRelayOptions;
  #connection: RelayConnection | null = null;
  #disposed = false;
  #wake: (() => void) | null = null;
  /** Resolves when the relay stopped (disposed); for tests and orderly quit. */
  readonly done: Promise<void>;

  constructor(options: HostRelayOptions) {
    this.#options = options;
    options.port.onMessage((message) => this.#toHost(message));
    options.port.onClose(() => this.dispose());
    this.done = this.#run();
  }

  get connected(): boolean {
    return this.#connection !== null;
  }

  #link(state: LinkState): void {
    if (this.#disposed) return;
    const message: LinkMessage = { t: "link", state };
    this.#options.port.post(message);
  }

  #toHost(message: unknown): void {
    const connection = this.#connection;
    // No session: dropped. The renderer's client re-sends what is still open after the next `ready`.
    if (connection === null || this.#disposed) return;
    try {
      connection.send({ t: "store", m: message as JsonValue });
    } catch {
      this.#options.log("store relay: a renderer message could not be framed (dropped)");
    }
  }

  /** Waits `ms`, or less when disposed. */
  #pause(ms: number): Promise<void> {
    const sleep = this.#options.sleep ?? defaultSleep;
    return new Promise<void>((resolve) => {
      this.#wake = resolve;
      void sleep(ms).then(resolve);
    }).then(() => {
      this.#wake = null;
    });
  }

  async #run(): Promise<void> {
    const retry = this.#options.retryMs ?? DEFAULT_RETRY;
    let backoff = retry.initial;
    let lost = false;
    while (!this.#disposed) {
      this.#link("connecting");
      let connection: RelayConnection;
      try {
        connection = await this.#options.connect(() => {
          this.#options.log("store relay: no host answered, starting one");
          this.#link("starting");
        });
      } catch (error) {
        if (this.#disposed) break;
        this.#options.log(
          `store relay: the host is unavailable (${error instanceof Error ? error.name : "error"}), retrying`,
        );
        this.#link("unavailable");
        await this.#pause(backoff);
        backoff = Math.min(backoff * 2, retry.max);
        continue;
      }
      if (this.#disposed) {
        connection.close();
        break;
      }
      backoff = retry.initial;
      if (lost) this.#options.log("store relay: reconnected to the host");
      const closed = new Promise<void>((resolve) => connection.onClose(resolve));
      this.#connection = connection;
      this.#link("connected");
      // Set after `connected`, so the host's store `ready` (kept until a handler is set) follows it.
      connection.onFrame((frame) => {
        if (this.#disposed) return;
        if (frame.t === "store") this.#options.port.post(frame.m);
        else this.#options.log(`store relay: unexpected ${frame.t} frame ignored`);
      });
      await closed;
      this.#connection = null;
      if (this.#disposed) break;
      lost = true;
      this.#options.log("store relay: the host connection closed, reconnecting");
    }
  }

  /** Stops relaying: closes the host session and the port. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#connection?.close();
    this.#connection = null;
    this.#wake?.();
    try {
      this.#options.port.close();
    } catch {
      // already closed by the other side
    }
  }
}

/**
 * The relays of all renderer frames: one per frame; a frame asking again (a reload) replaces its
 * relay, a destroyed page drops its relays, quit stops them all.
 */
export class HostRelays {
  readonly #relays = new Map<string, HostRelay>();

  constructor(private readonly create: (port: RelayPort) => HostRelay) {}

  get size(): number {
    return this.#relays.size;
  }

  /** A relay for `frame` (key: page id + frame id) over `port`; an older one of that frame stops. */
  open(frame: string, port: RelayPort): HostRelay {
    this.#relays.get(frame)?.dispose();
    const relay = this.create(port);
    this.#relays.set(frame, relay);
    void relay.done.then(() => {
      if (this.#relays.get(frame) === relay) this.#relays.delete(frame);
    });
    return relay;
  }

  /** Stops the relays of one page (every frame key starting with `page:`). */
  closePage(page: string): void {
    for (const [frame, relay] of this.#relays) {
      if (frame.startsWith(`${page}:`)) relay.dispose();
    }
  }

  /** Quit: every relay stops (the host lingers on its own and exits when idle). */
  closeAll(): void {
    for (const relay of [...this.#relays.values()]) relay.dispose();
  }
}
