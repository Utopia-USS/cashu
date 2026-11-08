// The host socket in one process: permissions, the handshake and its refusals (wrong token, wrong
// data dir, wrong major, squatter), role binding, deadlines and frame limits. Synthetic temp dirs only.
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";
import {
  answerChallenge,
  formatNonce,
  formatToken,
  type Hello,
  HOST_PROTOCOL,
  makeHello,
  type Role,
} from "@cashu/host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir, trackDir } from "../testing/hostHarness.js";
import { connectHost, HostConnectError } from "./client.js";
import { readDiscovery, readHostToken } from "./files.js";
import { FrameSocket } from "./frameSocket.js";
import { hostRunPaths } from "./paths.js";
import { HostBusyError, type HostSession, type RunningHost, startHost } from "./server.js";

const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  cleanup();
});

/** A host whose sessions echo `admin.*` / `cli.*` requests and record what they saw. */
async function host(
  dataDir: string,
  over: { helloDeadlineMs?: number; maxFrameBytes?: number; starting?: boolean } = {},
) {
  const sessions: HostSession[] = [];
  const h = await startHost({
    dataDir,
    build: "test-host",
    features: ["store.v2"],
    ...over,
    onSession(session) {
      sessions.push(session);
      session.onFrame((frame) => {
        if (frame.t === "req") {
          session.send({
            t: "res",
            id: frame.id,
            outcome: { ok: true, result: { echo: frame.method } },
          });
        }
      });
    },
  });
  hosts.push(h);
  return { h, sessions };
}

/** A raw socket client: send messages, await replies in order, see when the host closes. */
function raw(socketPath: string) {
  const conn = new FrameSocket(connect(socketPath));
  const queue: unknown[] = [];
  const waiters: ((m: unknown) => void)[] = [];
  conn.onMessage((m) => {
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const closed = new Promise<void>((resolve) => conn.onClose(() => resolve()));
  return {
    send: (m: unknown) => conn.send(m),
    next: () =>
      new Promise<unknown>((resolve) => {
        if (queue.length > 0) resolve(queue.shift());
        else waiters.push(resolve);
      }),
    closed,
    conn,
  };
}

const hello = (dataDirId: string, role: Role = "cli", over: Partial<Hello> = {}): Hello => ({
  ...makeHello({
    role,
    dataDir: dataDirId,
    build: "raw",
    nc: formatNonce(randomBytes(32)),
    protocol: HOST_PROTOCOL,
    ...(role === "mcp" ? { profile: "demo-anna" } : {}),
  }),
  ...over,
});

async function authed(socketPath: string, dataDir: string, role: Role = "cli") {
  const paths = hostRunPaths(dataDir);
  const token = readHostToken(paths.tokenPath);
  if (!token) throw new Error("no token");
  const c = raw(socketPath);
  const h = hello(paths.dataDirId, role);
  c.send(h);
  const step = answerChallenge(await c.next(), h, token);
  if (step.kind !== "auth") throw new Error(step.kind);
  c.send(step.reply);
  expect(await c.next()).toEqual({ t: "ready" });
  return c;
}

const connectError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HostConnectError) return { kind: e.kind, reason: e.reason };
    throw e;
  }
  return "connected";
};

describe("host socket", () => {
  it("refuses a different packaged content build for writer roles but permits admin", async () => {
    const dir = trackDir(tempDir());
    const first = `desktop-1.0.0-${"a".repeat(64)}`;
    const second = `desktop-1.0.0-${"b".repeat(64)}`;
    const h = await startHost({ dataDir: dir, build: first, onSession: () => undefined });
    hosts.push(h);
    for (const role of ["ui", "cli", "mcp"] as const) {
      expect(
        await connectError(
          connectHost({
            dataDir: dir,
            role,
            build: second,
            ...(role === "mcp" ? { profile: "demo-anna" } : {}),
          }),
        ),
      ).toEqual({ kind: "refused", reason: "build" });
    }
    const admin = await connectHost({ dataDir: dir, role: "admin", build: second });
    admin.close();
    const own = await connectHost({ dataDir: dir, role: "ui", build: first });
    own.close();
  });
  it("publishes a private socket, token and discovery file; never TCP", async () => {
    const dir = trackDir(tempDir());
    const { h } = await host(dir);
    const p = h.paths;
    expect(statSync(p.runDir).mode & 0o777).toBe(0o700);
    expect(statSync(p.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(p.socketPath).isSocket()).toBe(true);
    expect(statSync(p.tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(p.discoveryPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(p.tokenPath, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(readDiscovery(p.discoveryPath)).toMatchObject({
      format: 1,
      pid: process.pid,
      socket: p.socketPath,
      protocol: HOST_PROTOCOL,
      build: "test-host",
      dataDir: p.dataDirId,
    });
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/listen\(\s*\d|port\s*:/);
    await h.close();
    expect(() => statSync(p.socketPath)).toThrow();
    expect(readHostToken(p.tokenPath)).toBeUndefined();
    expect(readDiscovery(p.discoveryPath)).toBeUndefined();
    expect(h.lock.held).toBe(false);
  });

  it("serves an authenticated client bound to its role", async () => {
    const dir = trackDir(tempDir());
    const { h, sessions } = await host(dir);
    const c = await connectHost({ dataDir: dir, role: "admin", build: "client" });
    expect(c.host).toEqual({ protocol: HOST_PROTOCOL, build: "test-host", features: ["store.v2"] });
    expect(await c.call("admin.status")).toEqual({ echo: "admin.status" });
    expect(sessions[0]).toMatchObject({ role: "admin", profile: undefined, build: "client" });
    expect(h.sessionCounts()).toMatchObject({ admin: 1, cli: 0 });
    const mcp = await connectHost({
      dataDir: dir,
      role: "mcp",
      profile: "demo-anna",
      build: "client",
    });
    expect(sessions[1]).toMatchObject({ role: "mcp", profile: "demo-anna" });
    mcp.close();
    c.close();
  });

  it("closes a session that sends a frame its role may not send", async () => {
    const dir = trackDir(tempDir());
    const { h } = await host(dir);
    const cli = await authed(h.paths.socketPath, dir, "cli");
    cli.send({ t: "req", id: 1, method: "cli.exec", params: {} });
    expect(await cli.next()).toMatchObject({ t: "res", id: 1, outcome: { ok: true } });
    cli.send({ t: "store", m: { t: "unsub", sid: 1 } });
    await cli.closed;
    const admin = await authed(h.paths.socketPath, dir, "admin");
    admin.send({ t: "req", id: 1, method: "cli.exec", params: {} });
    await admin.closed;
    const bad = await authed(h.paths.socketPath, dir, "ui");
    bad.send({ t: "whatever" });
    await bad.closed;
  });

  it("delivers frames the host pushes right after ready once the client sets its handler", async () => {
    const dir = trackDir(tempDir());
    const h = await startHost({
      dataDir: dir,
      build: "test-host",
      onSession(session) {
        session.send({ t: "note", method: "store.ready", params: { pushed: 1 } });
        session.send({ t: "note", method: "store.ready", params: { pushed: 2 } });
      },
    });
    hosts.push(h);
    const c = await connectHost({ dataDir: dir, role: "ui", build: "c" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const seen: unknown[] = [];
    c.onFrame((frame) => seen.push(frame.t === "note" ? frame.params : frame.t));
    expect(seen).toEqual([{ pushed: 1 }, { pushed: 2 }]);
    c.close();
  });

  it("a second host on the same data dir is refused", async () => {
    const dir = trackDir(tempDir());
    await host(dir);
    await expect(startHost({ dataDir: dir, build: "b", onSession() {} })).rejects.toThrow(
      HostBusyError,
    );
  });
});

describe("handshake refusals", () => {
  it("wrong token: the client rejects the host and never sends its proof", async () => {
    const dir = trackDir(tempDir());
    const { h, sessions } = await host(dir);
    const real = readFileSync(h.paths.tokenPath, "utf8");
    writeFileSync(h.paths.tokenPath, formatToken(new Uint8Array(randomBytes(32))));
    expect(await connectError(connectHost({ dataDir: dir, role: "cli", build: "c" }))).toEqual({
      kind: "unverified",
      reason: undefined,
    });
    expect(sessions).toHaveLength(0);
    writeFileSync(h.paths.tokenPath, real);
    (await connectHost({ dataDir: dir, role: "cli", build: "c" })).close();
  });

  it("wrong token on the client's proof: the host refuses auth and closes", async () => {
    const dir = trackDir(tempDir());
    const { h, sessions } = await host(dir);
    const c = raw(h.paths.socketPath);
    c.send(hello(h.paths.dataDirId));
    expect(await c.next()).toMatchObject({ t: "challenge" });
    c.send({ t: "auth", proof: "0".repeat(64) });
    expect(await c.next()).toMatchObject({ t: "refused", reason: "auth" });
    await c.closed;
    expect(sessions).toHaveLength(0);
  });

  it("wrong data dir, wrong major, missing profile: fixed refusals, then close", async () => {
    const dir = trackDir(tempDir());
    const { h } = await host(dir);
    const refusedWith = async (m: unknown) => {
      const c = raw(h.paths.socketPath);
      c.send(m);
      const reply = (await c.next()) as { t: string; reason: string };
      await c.closed;
      return reply.t === "refused" ? reply.reason : reply.t;
    };
    expect(await refusedWith(hello("b".repeat(64)))).toBe("data-dir");
    expect(await refusedWith({ t: "hello", protocol: { major: 2, minor: 0 }, anything: 1 })).toBe(
      "protocol",
    );
    expect(await refusedWith({ ...hello(h.paths.dataDirId), role: "mcp" })).toBe("role");
    expect(await refusedWith({ t: "auth", proof: "0".repeat(64) })).toBe("invalid");
    // Through the client: a wrong major is final (no retry), reported as such.
    expect(
      await connectError(
        connectHost({ dataDir: dir, role: "cli", build: "c", protocol: { major: 2, minor: 0 } }),
      ),
    ).toEqual({ kind: "refused", reason: "protocol" });
  });

  it("a squatter on the socket learns nothing, and the next host takes the socket back", async () => {
    const dir = trackDir(tempDir());
    const paths = hostRunPaths(dir);
    // A dead host's token is still on disk; something else now listens on the socket path.
    const { h } = await host(dir);
    await h.close();
    hosts.length = 0;
    writeFileSync(paths.tokenPath, formatToken(new Uint8Array(randomBytes(32))), { mode: 0o600 });
    const seen: unknown[] = [];
    const squatter: Server = createServer((s) => {
      const conn = new FrameSocket(s);
      conn.onMessage((m) => {
        seen.push(m);
        conn.send({
          t: "challenge",
          ns: formatNonce(randomBytes(32)),
          proof: "f".repeat(64),
          protocol: HOST_PROTOCOL,
          build: "squatter",
          features: [],
        });
      });
    });
    await new Promise<void>((r) => squatter.listen(paths.socketPath, r));
    expect(
      await connectError(connectHost({ dataDir: dir, role: "cli", build: "c" })),
    ).toMatchObject({
      kind: "unverified",
    });
    expect(seen.map((m) => (m as { t: string }).t)).toEqual(["hello"]);
    // Only the lock holder replaces the socket: a new host unlinks the squatter's and binds its own.
    await host(dir);
    const c = await connectHost({ dataDir: dir, role: "admin", build: "c" });
    expect(c.host.build).toBe("test-host");
    expect(seen).toHaveLength(1);
    c.close();
    squatter.close();
  });

  it("a stopping host turns new clients away as retryable", async () => {
    const dir = trackDir(tempDir());
    const { h } = await host(dir);
    h.beginStop();
    expect(await connectError(connectHost({ dataDir: dir, role: "cli", build: "c" }))).toEqual({
      kind: "stopping",
      reason: "stopping",
    });
  });

  it("a starting host asks clients to wait for it, then serves them once ready", async () => {
    const dir = trackDir(tempDir());
    const { h, sessions } = await host(dir, { starting: true });
    expect(h.starting).toBe(true);
    // The host is findable (host.json) while it refuses every role, admin included.
    expect(readDiscovery(h.paths.discoveryPath)?.pid).toBe(process.pid);
    for (const role of ["cli", "admin"] as const) {
      const error = await connectError(connectHost({ dataDir: dir, role, build: "c" }));
      expect(error).toEqual({ kind: "starting", reason: "starting" });
    }
    expect(sessions).toHaveLength(0);
    h.ready();
    expect(h.starting).toBe(false);
    const c = await connectHost({ dataDir: dir, role: "cli", build: "c" });
    expect(await c.call("cli.exec")).toEqual({ echo: "cli.exec" });
    c.close();
  });

  it("no token or no socket reads as unavailable", async () => {
    const dir = trackDir(tempDir());
    expect(
      await connectError(connectHost({ dataDir: dir, role: "cli", build: "c" })),
    ).toMatchObject({
      kind: "unavailable",
    });
    const { h } = await host(dir);
    const token = readFileSync(h.paths.tokenPath, "utf8");
    await h.close();
    hosts.length = 0;
    writeFileSync(h.paths.tokenPath, token);
    expect(
      await connectError(connectHost({ dataDir: dir, role: "cli", build: "c" })),
    ).toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("connection limits", () => {
  it("closes a connection that does not finish the handshake in time", async () => {
    const dir = trackDir(tempDir());
    const { h } = await host(dir, { helloDeadlineMs: 100 });
    const silent = raw(h.paths.socketPath);
    await silent.closed;
    const halfway = raw(h.paths.socketPath);
    halfway.send(hello(h.paths.dataDirId));
    await halfway.next();
    await halfway.closed;
  });

  it("closes on an oversize frame header, invalid UTF-8 or invalid JSON", async () => {
    const dir = trackDir(tempDir());
    const { h } = await host(dir, { maxFrameBytes: 1024 });
    const send = async (bytes: Uint8Array) => {
      const s = connect(h.paths.socketPath);
      await new Promise<void>((r) => s.once("connect", () => r()));
      s.write(bytes);
      await new Promise<void>((r) => s.once("close", () => r()));
    };
    await send(Uint8Array.from([0, 0, 4, 1]));
    await send(Uint8Array.from([0, 0, 0, 2, 0xc3, 0x28]));
    await send(Uint8Array.from([0, 0, 0, 1, 0x7b]));
  });

  it("finds a socket moved to the short fallback directory through host.json", async () => {
    const base = trackDir(tempDir());
    const dir = join(base, "d".repeat(110));
    const short = trackDir(tempDir("ch-"));
    const sessions: HostSession[] = [];
    const h = await startHost({
      dataDir: dir,
      build: "test-host",
      pathEnv: { tmpDir: short },
      onSession: (s) => sessions.push(s),
    });
    hosts.push(h);
    expect(h.paths.socketDir.startsWith(short)).toBe(true);
    expect(statSync(h.paths.socketDir).mode & 0o777).toBe(0o700);
    // The client's own TMPDIR may differ (Claude Code sets one): host.json says where the socket is.
    const c = await connectHost({
      dataDir: dir,
      role: "cli",
      build: "c",
      pathEnv: { tmpDir: base },
    });
    expect(sessions).toHaveLength(1);
    c.close();
  });
});
