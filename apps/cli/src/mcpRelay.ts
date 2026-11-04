// `cashu mcp --profile <slug>`: the shim relays MCP JSON-RPC lines between its stdio (Claude Code)
// and an `mcp` session of the host, where the server runs. It answers nothing itself, with three
// exceptions that keep a long-lived agent session working across host restarts (an update handover,
// a crash, `cashu host stop`):
//   - it keeps the client's `initialize` request (and whether `notifications/initialized` followed);
//     after a reconnect it replays both to the new session, swallows the replayed reply and sends the
//     client `notifications/tools/list_changed` (the host advertises `tools.listChanged`);
//   - requests in flight when the session dropped are answered with an error (a tool call as a tool
//     error), never replayed: a write may or may not have run, and only the agent can check;
//   - while no host can be reached, requests are answered with an error and the next request tries
//     again. Lines that arrive during a reconnect wait for it.
// The session ends when the server exits (`mcp.exit`, also after stdin ended and `mcp.eof` closed its
// input): the shim exits with the server's code and does not reconnect.
import { type HostFrame, mcpExitNoteSchema, mcpStderrNoteSchema } from "@cashu/host-protocol";
import type { HostConnection } from "@cashu/node-host";

export interface McpRelayDeps {
  /** Connects (or starts a host) and opens the session; rejects when no host can be reached. */
  connect(): Promise<HostConnection>;
  writeLine(line: string): void;
  writeErr(text: string): void;
  /** The relay is done (stdin ended, or the server exited): exit with `code`. */
  exit(code: number): void;
  /** Tool error texts (already in the agent's languages). */
  readonly texts: { readonly lost: string; readonly unavailable: string };
  /** How long a replayed `initialize` may take (default 30 s). */
  readonly replayTimeoutMs?: number;
}

type Json = Record<string, unknown>;

const LIST_CHANGED = JSON.stringify({
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
});

function parse(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Json)
      : undefined;
  } catch {
    return undefined;
  }
}

const isRequest = (m: Json) => typeof m.method === "string" && "id" in m && m.id !== null;
const isResponse = (m: Json) => !("method" in m) && "id" in m && ("result" in m || "error" in m);
const idKey = (id: unknown) => JSON.stringify(id);

export class McpRelay {
  private readonly deps: McpRelayDeps;
  private conn: HostConnection | undefined;
  private state: "connecting" | "open" | "down" | "done" = "connecting";
  private initialize: Json | undefined;
  private initialized = false;
  private readonly inflight = new Map<string, { id: unknown; method: string }>();
  private queue: string[] = [];
  private replay: { key: string; settle: (ok: boolean) => void } | undefined;
  private replays = 0;
  private serverExit: number | undefined;
  private stdinEnded = false;

  constructor(deps: McpRelayDeps) {
    this.deps = deps;
  }

  /** Starts with a connection the caller already opened. */
  start(conn: HostConnection): void {
    this.attach(conn);
    this.state = "open";
  }

  /** One line from the client (stdin), without its newline. */
  clientLine(line: string): void {
    if (this.state === "done") return;
    const msg = parse(line);
    if (msg !== undefined) {
      if (msg.method === "initialize" && isRequest(msg)) this.initialize = msg;
      if (msg.method === "notifications/initialized") this.initialized = true;
      if (isRequest(msg))
        this.inflight.set(idKey(msg.id), { id: msg.id, method: msg.method as string });
    }
    if (this.state === "open" && this.conn !== undefined) {
      this.conn.send({ t: "mcp", line });
      return;
    }
    this.queue.push(line);
    if (this.state === "down") void this.reconnect();
  }

  /**
   * The client closed stdin: the server's input ends too, and the relay exits with the server's code
   * when it is gone. Without a session there is nothing to
   * wait for.
   */
  stdinEnd(): void {
    this.stdinEnded = true;
    if (this.conn !== undefined && this.state === "open") this.endInput(this.conn);
    else if (this.state !== "connecting") this.finish(0);
  }

  private endInput(conn: HostConnection): void {
    conn.call("mcp.eof").catch(() => conn.close());
  }

  private attach(conn: HostConnection): void {
    this.conn = conn;
    conn.onFrame((frame) => this.hostFrame(conn, frame));
    conn.onClose(() => this.lost(conn));
  }

  private hostFrame(conn: HostConnection, frame: HostFrame): void {
    if (conn !== this.conn) return;
    if (frame.t === "mcp") {
      const msg = parse(frame.line);
      if (msg !== undefined && isResponse(msg)) {
        const key = idKey(msg.id);
        if (this.replay !== undefined && key === this.replay.key) {
          this.replay.settle("result" in msg);
          return;
        }
        this.inflight.delete(key);
      }
      this.deps.writeLine(frame.line);
      return;
    }
    if (frame.t !== "note") return;
    if (frame.method === "mcp.stderr") {
      const note = mcpStderrNoteSchema.safeParse(frame.params);
      if (note.success) this.deps.writeErr(note.data.data);
    } else if (frame.method === "mcp.exit") {
      const note = mcpExitNoteSchema.safeParse(frame.params);
      this.serverExit = note.success ? note.data.code : 1;
    }
  }

  private lost(conn: HostConnection): void {
    if (conn !== this.conn) return;
    this.conn = undefined;
    this.replay?.settle(false);
    if (this.serverExit !== undefined || this.stdinEnded) {
      this.finish(this.serverExit ?? 0);
      return;
    }
    this.answerAll(this.inflight.values(), this.deps.texts.lost);
    this.inflight.clear();
    void this.reconnect();
  }

  private reconnecting = false;

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.state === "done") return;
    this.reconnecting = true;
    this.state = "connecting";
    let conn: HostConnection | undefined;
    try {
      conn = await this.deps.connect();
      this.attach(conn);
      if (this.initialize !== undefined && !(await this.replayInitialize(conn))) {
        throw new Error("the replayed initialize failed");
      }
    } catch {
      if (conn !== undefined && this.conn === conn) {
        this.conn = undefined;
        conn.close();
      }
      this.reconnecting = false;
      if (this.stdinEnded) return this.finish(0);
      this.state = "down";
      const queued = this.queue.splice(0);
      const requests = queued.map(parse).filter((m): m is Json => m !== undefined && isRequest(m));
      for (const m of requests) this.inflight.delete(idKey(m.id));
      this.answerAll(
        requests.map((m) => ({ id: m.id, method: m.method as string })),
        this.deps.texts.unavailable,
      );
      return;
    }
    this.reconnecting = false;
    if (this.initialized) {
      conn.send({
        t: "mcp",
        line: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      this.deps.writeLine(LIST_CHANGED);
    }
    this.state = "open";
    for (const line of this.queue.splice(0)) conn.send({ t: "mcp", line });
    if (this.stdinEnded) this.endInput(conn);
  }

  private replayInitialize(conn: HostConnection): Promise<boolean> {
    this.replays += 1;
    const id = `cashu-shim-replay-${this.replays}`;
    const request = { ...this.initialize, id };
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), this.deps.replayTimeoutMs ?? 30_000);
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        this.replay = undefined;
        resolve(ok);
      };
      this.replay = { key: idKey(id), settle };
      conn.send({ t: "mcp", line: JSON.stringify(request) });
    });
  }

  private answerAll(requests: Iterable<{ id: unknown; method: string }>, text: string): void {
    for (const { id, method } of requests) {
      const reply =
        method === "tools/call"
          ? { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } }
          : { jsonrpc: "2.0", id, error: { code: -32603, message: text } };
      this.deps.writeLine(JSON.stringify(reply));
    }
  }

  private finish(code: number): void {
    if (this.state === "done") return;
    this.state = "done";
    this.deps.exit(code);
  }
}
