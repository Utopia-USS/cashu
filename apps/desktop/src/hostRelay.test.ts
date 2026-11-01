import type { ClientFrame, HostFrame } from "@cashu/host-protocol";
import { describe, expect, it, vi } from "vitest";
import { HostRelay, HostRelays, type RelayConnection, type RelayPort } from "./hostRelay.js";

class FakePort implements RelayPort {
  readonly posted: unknown[] = [];
  closed = false;
  #onMessage: (message: unknown) => void = () => {};
  #onClose: () => void = () => {};
  post(message: unknown): void {
    this.posted.push(message);
  }
  onMessage(handler: (message: unknown) => void): void {
    this.#onMessage = handler;
  }
  onClose(handler: () => void): void {
    this.#onClose = handler;
  }
  close(): void {
    this.closed = true;
  }
  /** The renderer posts. */
  fromRenderer(message: unknown): void {
    this.#onMessage(message);
  }
  /** The renderer's end went away. */
  rendererGone(): void {
    this.#onClose();
  }
  links(): string[] {
    return this.posted
      .filter((m): m is { t: "link"; state: string } => (m as { t?: string }).t === "link")
      .map((m) => m.state);
  }
}

class FakeConnection implements RelayConnection {
  readonly sent: ClientFrame[] = [];
  closed = false;
  #onFrame: ((frame: HostFrame) => void) | undefined;
  readonly #early: HostFrame[] = [];
  readonly #onClose: (() => void)[] = [];
  send(frame: ClientFrame): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(frame);
  }
  onFrame(handler: (frame: HostFrame) => void): void {
    this.#onFrame = handler;
    for (const frame of this.#early.splice(0)) handler(frame);
  }
  onClose(handler: () => void): void {
    this.#onClose.push(handler);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.#onClose) handler();
  }
  /** The host pushes a frame (kept until a handler is set, as node-host's client does). */
  push(frame: HostFrame): void {
    if (this.#onFrame === undefined) this.#early.push(frame);
    else this.#onFrame(frame);
  }
}

const READY = { t: "ready", protocol: 2, vaults: [] };

/** A host that answers connects from a queue of outcomes. */
function hostOf(outcomes: ("ok" | "start" | "fail")[]) {
  const connections: FakeConnection[] = [];
  const connect = vi.fn(async (onStarting: () => void) => {
    const outcome = outcomes.shift() ?? "ok";
    if (outcome === "fail") throw new Error("no host");
    if (outcome === "start") onStarting();
    const connection = new FakeConnection();
    connection.push({ t: "store", m: READY });
    connections.push(connection);
    return connection;
  });
  return { connect, connections };
}

function relayOf(outcomes: ("ok" | "start" | "fail")[] = []) {
  const port = new FakePort();
  const host = hostOf(outcomes);
  const log: string[] = [];
  const relay = new HostRelay({
    port,
    connect: host.connect,
    log: (line) => log.push(line),
    sleep: () => Promise.resolve(),
    retryMs: { initial: 1, max: 4 },
  });
  return { port, host, log, relay };
}

describe("HostRelay", () => {
  it("connects, says so, then forwards the host's store messages untouched", async () => {
    const { port, host, relay } = relayOf();
    await vi.waitFor(() => expect(relay.connected).toBe(true));
    expect(port.posted).toEqual([
      { t: "link", state: "connecting" },
      { t: "link", state: "connected" },
      READY,
    ]);
    const value = { t: "value", sid: 1, value: { "~cashu": "decimal", v: "1.50" } };
    host.connections[0]?.push({ t: "store", m: value });
    expect(port.posted.at(-1)).toBe(value);
    relay.dispose();
  });

  it("wraps what the renderer posts into store frames without reading it", async () => {
    const { port, host, relay } = relayOf();
    await vi.waitFor(() => expect(relay.connected).toBe(true));
    const message = { t: "run", rid: 1, anything: ["the host validates"] };
    port.fromRenderer(message);
    expect(host.connections[0]?.sent).toEqual([{ t: "store", m: message }]);
    relay.dispose();
  });

  it("drops renderer messages while no session is up", async () => {
    const port = new FakePort();
    let release: (c: FakeConnection) => void = () => {};
    const relay = new HostRelay({
      port,
      connect: () => new Promise<FakeConnection>((resolve) => (release = resolve)),
      log: () => {},
    });
    port.fromRenderer({ t: "sub", sid: 1 });
    const connection = new FakeConnection();
    release(connection);
    await vi.waitFor(() => expect(relay.connected).toBe(true));
    expect(connection.sent).toEqual([]);
    relay.dispose();
  });

  it("says `starting` when it had to start the host", async () => {
    const { port, relay } = relayOf(["start"]);
    await vi.waitFor(() => expect(relay.connected).toBe(true));
    expect(port.links()).toEqual(["connecting", "starting", "connected"]);
    relay.dispose();
  });

  it("reconnects when the host goes away, starting a new one", async () => {
    const { port, host, relay, log } = relayOf(["ok", "start"]);
    await vi.waitFor(() => expect(host.connections).toHaveLength(1));
    host.connections[0]?.close(); // the host was killed
    await vi.waitFor(() => expect(host.connections).toHaveLength(2));
    await vi.waitFor(() => expect(relay.connected).toBe(true));
    expect(port.links()).toEqual([
      "connecting",
      "connected",
      "connecting",
      "starting",
      "connected",
    ]);
    // The new session's ready reached the renderer after its `connected`.
    expect(port.posted.at(-1)).toEqual(READY);
    port.fromRenderer({ t: "unsub", sid: 3 });
    expect(host.connections[1]?.sent).toEqual([{ t: "store", m: { t: "unsub", sid: 3 } }]);
    expect(log.some((l) => l.includes("reconnected"))).toBe(true);
    relay.dispose();
  });

  it("reports `unavailable` and retries with backoff until a host answers", async () => {
    const sleeps: number[] = [];
    const port = new FakePort();
    const host = hostOf(["fail", "fail", "fail", "fail", "ok"]);
    const relay = new HostRelay({
      port,
      connect: host.connect,
      log: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retryMs: { initial: 100, max: 300 },
    });
    await vi.waitFor(() => expect(relay.connected).toBe(true));
    expect(sleeps).toEqual([100, 200, 300, 300]);
    expect(port.links().filter((s) => s === "unavailable")).toHaveLength(4);
    relay.dispose();
  });

  it("stops when the renderer's port closes: the session closes, nothing more is posted", async () => {
    const { port, host, relay } = relayOf();
    await vi.waitFor(() => expect(relay.connected).toBe(true));
    port.rendererGone();
    await relay.done;
    expect(host.connections[0]?.closed).toBe(true);
    expect(port.closed).toBe(true);
    const count = port.posted.length;
    host.connections[0]?.push({ t: "store", m: READY });
    expect(port.posted).toHaveLength(count);
    expect(host.connect).toHaveBeenCalledTimes(1);
  });

  it("closes a connection that arrives after it was disposed", async () => {
    const port = new FakePort();
    let release: (c: FakeConnection) => void = () => {};
    const relay = new HostRelay({
      port,
      connect: () => new Promise<FakeConnection>((resolve) => (release = resolve)),
      log: () => {},
    });
    relay.dispose();
    const late = new FakeConnection();
    release(late);
    await relay.done;
    expect(late.closed).toBe(true);
    expect(port.links()).toEqual(["connecting"]);
  });

  it("ignores frames of other channels", async () => {
    const { port, host, relay, log } = relayOf();
    await vi.waitFor(() => expect(relay.connected).toBe(true));
    const count = port.posted.length;
    host.connections[0]?.push({ t: "note", method: "events.changed", params: {} });
    expect(port.posted).toHaveLength(count);
    expect(log.at(-1)).toContain("unexpected note frame");
    relay.dispose();
  });
});

describe("HostRelays", () => {
  it("keeps one relay per frame: a reload replaces it, a closed page drops its relays", async () => {
    const created: { port: FakePort; relay: HostRelay }[] = [];
    const relays = new HostRelays((port) => {
      const relay = new HostRelay({ port, connect: hostOf([]).connect, log: () => {} });
      created.push({ port: port as FakePort, relay });
      return relay;
    });
    relays.open("7:1:1", new FakePort());
    relays.open("7:1:1", new FakePort());
    relays.open("8:1:1", new FakePort());
    await created[0]?.relay.done;
    expect(created[0]?.port.closed).toBe(true);
    await vi.waitFor(() => expect(relays.size).toBe(2));
    relays.closePage("7");
    await vi.waitFor(() => expect(relays.size).toBe(1));
    relays.closeAll();
    await vi.waitFor(() => expect(relays.size).toBe(0));
    expect(created.every(({ port }) => port.closed)).toBe(true);
  });
});
