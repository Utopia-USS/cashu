// MCP sessions over a real host socket with a stand-in for the Python CLI (test-fixtures): mcp.open
// first, lines both ways, the initialize reply advertising tools.listChanged (and nothing else
// changed), stderr notes, mcp.exit when the server ends on its own (an unknown profile), the server's
// environment (the host's data dir wins) and working directory, and servers stopped with their session
// and with the host.
import { fileURLToPath } from "node:url";
import type { HostFrame } from "@cashu/host-protocol";
import { connectHost, type HostConnection } from "@cashu/node-host";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { advertiseListChanged } from "./session.js";

afterEach(cleanup);

const FAKE = fileURLToPath(new URL("../../test-fixtures/fake-python-cli.mjs", import.meta.url));

async function session(profile = "demo-anna") {
  const dir = tempDir();
  const h = await startLocalHost({
    ...testHostOptions(dir),
    python: { command: FAKE, args: [] },
    launcher: false,
  });
  const conn = await connectHost({ dataDir: dir, role: "mcp", profile, build: "test" });
  const frames: HostFrame[] = [];
  const waiters: (() => void)[] = [];
  conn.onFrame((f) => {
    frames.push(f);
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<void>((resolve) => conn.onClose(resolve));
  const next = async (pred: (f: HostFrame) => boolean): Promise<HostFrame> => {
    for (;;) {
      const i = frames.findIndex(pred);
      if (i !== -1) return frames.splice(i, 1)[0] as HostFrame;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const line = async (id: unknown) =>
    JSON.parse(
      ((await next((f) => f.t === "mcp" && JSON.parse(f.line).id === id)) as { line: string }).line,
    );
  return { dir, h, conn, frames, next, line, closed };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const send = (conn: HostConnection, msg: unknown) =>
  conn.send({ t: "mcp", line: JSON.stringify(msg) });

describe("mcp sessions", () => {
  it("relays lines after mcp.open and advertises tools.listChanged on initialize", async () => {
    const s = await session();
    await s.conn.call("mcp.open", { cwd: s.dir, env: {} });
    send(s.conn, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "x" } });
    const init = await s.line(1);
    expect(init.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect(init.result.serverInfo).toEqual({ name: "cashu-demo-anna", version: "0.0.0" });
    send(s.conn, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(s.conn, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await s.line(2)).result.tools.map((t: { name: string }) => t.name)).toEqual([
      "echo",
      "slow",
    ]);
    const stderr = await s.next((f) => f.t === "note" && f.method === "mcp.stderr");
    expect(stderr).toMatchObject({ params: { data: "fake mcp: serving demo-anna\n" } });
    s.conn.close();
    await s.h.stop();
  });

  it("runs the server in the shim's cwd with the host's data dir over any forwarded one", async () => {
    const s = await session();
    const cwd = tempDir("cashu-mcp-cwd-");
    await s.conn.call("mcp.open", {
      cwd,
      env: { CASHU_DATA_DIR: "/elsewhere", CASHU_MARK: "from-client" },
    });
    send(s.conn, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo" } });
    const out = JSON.parse((await s.line(7)).result.content[0].text);
    expect(out).toMatchObject({
      cwd,
      env: { CASHU_DATA_DIR: s.h.server.paths.dataDir, CASHU_MARK: "from-client" },
    });
    s.conn.close();
    await s.h.stop();
  });

  it("ends the session with mcp.exit when the server exits on its own", async () => {
    const s = await session("missing");
    await s.conn.call("mcp.open", { cwd: s.dir, env: {} });
    const exit = await s.next((f) => f.t === "note" && f.method === "mcp.exit");
    expect(exit).toMatchObject({ params: { code: 1 } });
    await s.closed;
    const err = s.frames.find((f) => f.t === "note" && f.method === "mcp.stderr");
    expect(err).toMatchObject({ params: { data: "No profile 'missing'. Profiles: demo.\n" } });
    await s.h.stop();
  });

  it("refuses lines before mcp.open and a second open", async () => {
    const s = await session();
    await s.conn.call("mcp.open", { cwd: s.dir, env: {} });
    await expect(s.conn.call("mcp.open", { cwd: s.dir, env: {} })).rejects.toMatchObject({
      code: "unknown-method",
    });
    s.conn.close();
    const t = await session();
    send(t.conn, { jsonrpc: "2.0", id: 1, method: "ping" });
    await t.closed;
    await s.h.stop();
    await t.h.stop();
  });

  it("stops the server with its session and with the host", async () => {
    const s = await session();
    const pidOf = async (conn: HostConnection, id: number, line: typeof s.line) => {
      send(conn, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo" } });
      return JSON.parse((await line(id)).result.content[0].text).pid as number;
    };
    await s.conn.call("mcp.open", { cwd: s.dir, env: {} });
    const first = await pidOf(s.conn, 1, s.line);
    // A second session whose server is still running when the host stops.
    const c2 = await connectHost({
      dataDir: s.dir,
      role: "mcp",
      profile: "demo-piotr",
      build: "t",
    });
    const lines: string[] = [];
    c2.onFrame((f) => {
      if (f.t === "mcp") lines.push(f.line);
    });
    await c2.call("mcp.open", { cwd: s.dir, env: {} });
    send(c2, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo" } });
    while (lines.length === 0) await new Promise((r) => setTimeout(r, 10));
    const second = JSON.parse(JSON.parse(lines[0] as string).result.content[0].text).pid as number;
    s.conn.close();
    for (let i = 0; i < 100 && alive(first); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive(first)).toBe(false);
    expect(alive(second)).toBe(true);
    expect(await s.h.stop()).toBe(0);
    expect(alive(second)).toBe(false);
  });

  it("rewrites only the initialize reply, keeping the server's other fields", () => {
    const ids = new Set([JSON.stringify(5)]);
    const reply = JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      result: { capabilities: { tools: {}, prompts: { x: 1 } }, protocolVersion: "v" },
    });
    expect(JSON.parse(advertiseListChanged(reply, ids))).toEqual({
      jsonrpc: "2.0",
      id: 5,
      result: {
        capabilities: { tools: { listChanged: true }, prompts: { x: 1 } },
        protocolVersion: "v",
      },
    });
    expect(ids.size).toBe(0);
    const other = JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      result: { capabilities: { tools: {} } },
    });
    expect(advertiseListChanged(other, ids)).toBe(other);
  });
});
