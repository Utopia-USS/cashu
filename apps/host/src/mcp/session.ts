// The host side of an `mcp` session (S56d): `mcp.open {cwd, env}` first, then MCP JSON-RPC lines both
// ways (and `mcp.eof` when the client's stdin ended) between the shim and the session's server (a backend; today the Python child, python.ts,
// TRANSITIONAL(S38f); the S38 slices plug the host's own tool registry in here). The session is bound
// to the profile named at hello. The transport adds one thing to the server's answer: the reply to
// `initialize` advertises `tools.listChanged`, because the shim sends
// `notifications/tools/list_changed` after it reconnected to a restarted host. When the server exits on
// its own the shim gets `mcp.exit` and stops; when the host stops, the session just closes.
import { type McpOpenParams, mcpOpenParamsSchema } from "@cashu/host-protocol";
import type { HostSession } from "@cashu/node-host";
import type { HostLog } from "../log.js";

/** A running MCP server for one session. */
export interface McpBackend {
  send(line: string): void;
  /** Ends the server's input (the client closed its stdin); the server exits on its own. */
  endInput(): void;
  onLine(handler: (line: string) => void): void;
  onStderr(handler: (data: string) => void): void;
  /** Called once when the server exited (code 0-255). */
  onExit(handler: (code: number) => void): void;
  /** Stops the server; resolves when it is gone. */
  close(): Promise<void>;
}

export interface McpSessionDeps {
  /** Starts the session's server; undefined when this build cannot serve MCP (no Python, TRANSITIONAL(S49)). */
  start(profile: string, open: McpOpenParams): McpBackend | undefined;
  readonly log: HostLog;
  /** Tracks running servers so a stopping host can end them. */
  readonly track: (backend: McpBackend) => () => void;
}

const MAX_STDERR_NOTE = 64 * 1024;

type Json = Record<string, unknown>;

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

/** The server's `initialize` reply with `capabilities.tools.listChanged` set; other lines unchanged. */
export function advertiseListChanged(line: string, initializeIds: Set<string>): string {
  const msg = parse(line);
  if (msg === undefined || "method" in msg || !initializeIds.has(JSON.stringify(msg.id)))
    return line;
  initializeIds.delete(JSON.stringify(msg.id));
  const result = msg.result;
  if (typeof result !== "object" || result === null) return line;
  const capabilities = (result as Json).capabilities;
  if (typeof capabilities !== "object" || capabilities === null) return line;
  const tools = (capabilities as Json).tools;
  if (typeof tools !== "object" || tools === null) return line;
  (tools as Json).listChanged = true;
  return JSON.stringify(msg);
}

export function serveMcpSession(session: HostSession, deps: McpSessionDeps): void {
  const profile = session.profile;
  if (profile === undefined) {
    session.close();
    return;
  }
  let backend: McpBackend | undefined;
  let untrack: () => void = () => {};
  const initializeIds = new Set<string>();

  session.onFrame((frame) => {
    if (frame.t === "req") {
      if (frame.method === "mcp.eof" && backend !== undefined) {
        backend.endInput();
        session.send({ t: "res", id: frame.id, outcome: { ok: true, result: {} } });
        return;
      }
      if (frame.method !== "mcp.open" || backend !== undefined) {
        session.send({
          t: "res",
          id: frame.id,
          outcome: { ok: false, error: { code: "unknown-method", message: frame.method } },
        });
        return;
      }
      const open = mcpOpenParamsSchema.safeParse(frame.params);
      if (!open.success) {
        session.send({
          t: "res",
          id: frame.id,
          outcome: { ok: false, error: { code: "invalid-params", message: frame.method } },
        });
        return;
      }
      const started = deps.start(profile, open.data);
      if (started === undefined) {
        deps.log.warn("mcp.unavailable");
        session.send({
          t: "res",
          id: frame.id,
          outcome: {
            ok: false,
            error: { code: "unavailable", message: "no MCP server in this build" },
          },
        });
        return session.close();
      }
      backend = started;
      untrack = deps.track(started);
      started.onLine((line) =>
        session.send({ t: "mcp", line: advertiseListChanged(line, initializeIds) }),
      );
      started.onStderr((data) => {
        for (let i = 0; i < data.length; i += MAX_STDERR_NOTE) {
          session.send({
            t: "note",
            method: "mcp.stderr",
            params: { data: data.slice(i, i + MAX_STDERR_NOTE) },
          });
        }
      });
      started.onExit((code) => {
        deps.log.info("mcp.server-exit", { code });
        untrack();
        session.send({ t: "note", method: "mcp.exit", params: { code } });
        session.close();
      });
      deps.log.info("mcp.open");
      session.send({ t: "res", id: frame.id, outcome: { ok: true, result: {} } });
      return;
    }
    if (frame.t === "mcp") {
      if (backend === undefined) return session.close();
      const msg = parse(frame.line);
      if (msg?.method === "initialize" && "id" in msg) initializeIds.add(JSON.stringify(msg.id));
      backend.send(frame.line);
      return;
    }
    // A cancel has nothing to cancel here (MCP has its own notifications/cancelled).
  });
  session.onClose(() => {
    if (backend === undefined) return;
    const b = backend;
    void b.close().then(untrack);
  });
}
