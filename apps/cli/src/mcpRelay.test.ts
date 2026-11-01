// The MCP relay with fake host connections: lines pass through; after the session drops, in-flight
// requests get errors (a tool call as a tool error), the client's initialize is replayed and its reply
// swallowed, list_changed is sent, lines that arrived meanwhile follow; no host -> errors, the next
// request tries again; mcp.exit ends the relay with the server's code.
import type { ClientFrame, HostFrame } from "@cashu/host-protocol";
import type { HostConnection } from "@cashu/node-host";
import { describe, expect, it } from "vitest";
import { McpRelay } from "./mcpRelay.js";

class FakeConn {
  readonly sent: ClientFrame[] = [];
  private frame: (f: HostFrame) => void = () => {};
  private closeHandlers: (() => void)[] = [];
  /** Answers the replayed initialize like a server. */
  autoInit = true;

  asConnection(): HostConnection {
    return {
      role: "mcp",
      host: { protocol: { major: 1, minor: 2 }, build: "t", features: ["mcp.lines"] },
      send: (f) => {
        this.sent.push(f);
        if (f.t === "mcp" && this.autoInit) {
          const m = JSON.parse(f.line);
          if (m.method === "initialize") {
            queueMicrotask(() =>
              this.push({ jsonrpc: "2.0", id: m.id, result: { capabilities: { tools: {} } } }),
            );
          }
        }
      },
      onFrame: (h) => {
        this.frame = h;
      },
      onClose: (h) => {
        this.closeHandlers.push(h);
      },
      call: async () => ({}),
      close: () => this.drop(),
    };
  }

  push(msg: unknown): void {
    this.frame({ t: "mcp", line: JSON.stringify(msg) });
  }

  note(method: string, params: unknown): void {
    this.frame({ t: "note", method, params: params as never });
  }

  drop(): void {
    for (const h of this.closeHandlers.splice(0)) h();
  }

  lines(): unknown[] {
    return this.sent
      .filter((f) => f.t === "mcp")
      .map((f) => JSON.parse((f as { line: string }).line));
  }
}

function setup(connects: (() => Promise<FakeConn>)[]) {
  const out: unknown[] = [];
  const err: string[] = [];
  let exit: number | undefined;
  const relay = new McpRelay({
    connect: async () => {
      const next = connects.shift();
      if (next === undefined) throw new Error("no host");
      return (await next()).asConnection();
    },
    writeLine: (l) => out.push(JSON.parse(l)),
    writeErr: (t) => err.push(t),
    exit: (code) => {
      exit = code;
    },
    texts: { lost: "LOST", unavailable: "DOWN" },
  });
  return { relay, out, err, exit: () => exit };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const line = (m: unknown) => JSON.stringify(m);
const INIT = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "v" } };

describe("McpRelay", () => {
  it("relays both ways and passes stderr on", () => {
    const first = new FakeConn();
    first.autoInit = false;
    const s = setup([]);
    s.relay.start(first.asConnection());
    s.relay.clientLine(line(INIT));
    first.push({ jsonrpc: "2.0", id: 0, result: { ok: 1 } });
    first.note("mcp.stderr", { data: "warn\n" });
    expect(first.lines()).toEqual([INIT]);
    expect(s.out).toEqual([{ jsonrpc: "2.0", id: 0, result: { ok: 1 } }]);
    expect(s.err).toEqual(["warn\n"]);
  });

  it("survives a host restart: errors for in-flight calls, initialize replayed, list_changed", async () => {
    const first = new FakeConn();
    first.autoInit = false;
    const second = new FakeConn();
    const s = setup([async () => second]);
    s.relay.start(first.asConnection());
    s.relay.clientLine(line(INIT));
    first.push({ jsonrpc: "2.0", id: 0, result: {} });
    s.relay.clientLine(line({ jsonrpc: "2.0", method: "notifications/initialized" }));
    s.relay.clientLine(
      line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } }),
    );
    s.relay.clientLine(line({ jsonrpc: "2.0", id: "p", method: "ping" }));
    first.drop();
    s.relay.clientLine(line({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    await tick();
    expect(s.out.slice(1)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "LOST" }], isError: true },
      },
      { jsonrpc: "2.0", id: "p", error: { code: -32603, message: "LOST" } },
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
    ]);
    expect(second.lines()).toEqual([
      { ...INIT, id: "cashu-shim-replay-1" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    second.push({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(s.out.at(-1)).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  });

  it("answers with errors while no host can be reached and retries on the next request", async () => {
    const first = new FakeConn();
    first.autoInit = false;
    const third = new FakeConn();
    const s = setup([
      async () => {
        throw new Error("down");
      },
      async () => third,
    ]);
    s.relay.start(first.asConnection());
    first.drop();
    await tick();
    s.relay.clientLine(line({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} }));
    await tick();
    expect(third.lines()).toEqual([{ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} }]);
    expect(s.out).toEqual([]);
  });

  it("errors queued requests when the retry fails too", async () => {
    const first = new FakeConn();
    const s = setup([]);
    s.relay.start(first.asConnection());
    first.drop();
    await tick();
    s.relay.clientLine(line({ jsonrpc: "2.0", id: 6, method: "tools/list" }));
    await tick();
    expect(s.out).toEqual([{ jsonrpc: "2.0", id: 6, error: { code: -32603, message: "DOWN" } }]);
  });

  it("exits with the server's code after mcp.exit, and with 0 when stdin ends", async () => {
    const first = new FakeConn();
    const s = setup([]);
    s.relay.start(first.asConnection());
    first.note("mcp.exit", { code: 1 });
    first.drop();
    expect(s.exit()).toBe(1);
    const other = new FakeConn();
    const t = setup([]);
    t.relay.start(other.asConnection());
    t.relay.stdinEnd();
    expect(t.exit()).toBeUndefined();
    other.note("mcp.exit", { code: 0 });
    other.drop();
    expect(t.exit()).toBe(0);
  });
});
