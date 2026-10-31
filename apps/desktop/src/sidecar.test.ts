/// <reference types="node" />
import { type SpawnOptions, spawn, type spawnSync } from "node:child_process";
import { type AddressInfo, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isPortFree } from "./net.js";
import {
  buildSidecarEnv,
  Sidecar,
  SidecarError,
  type SpawnFn,
  sidecarArgs,
  sidecarSpec,
  verifyDataDir,
} from "./sidecar.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "fake-serve.mjs");
const spec = { command: process.execPath, args: [FAKE], cwd: process.cwd() };

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function make(mode: string, extra: Partial<ConstructorParameters<typeof Sidecar>[0]> = {}) {
  const lines: string[] = [];
  const sidecar = new Sidecar({
    spec,
    dataDir: "/tmp/cashu-desktop-test-data",
    baseEnv: { ...process.env, FAKE_MODE: mode },
    onLog: (line) => lines.push(line),
    startupTimeoutMs: 5000,
    stopTimeoutMs: 3000,
    ...extra,
  });
  return { sidecar, lines };
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

describe("sidecar start and stop (shell.ServerThread)", () => {
  it("generates the token, hands it over stdin, waits for the health probe and stops the child", async () => {
    const { sidecar, lines } = make("ok");
    const info = await sidecar.start();
    expect(info.port).toBeGreaterThan(1023);
    expect(info.origin).toBe(`http://127.0.0.1:${info.port}`);
    expect(info.url).toBe(`${info.origin}/`);
    expect(info.token).toMatch(TOKEN_SHAPE);
    expect(sidecar.running).toBe(true);
    const health = `${info.origin}/api/health`;
    expect((await fetch(health, { headers: { "X-Cashu-Token": info.token } })).status).toBe(200);
    expect((await fetch(health)).status).toBe(401);

    // The request log never reaches the log.
    expect(lines.join("\n")).toContain("Application startup complete");
    expect(lines.join("\n")).not.toContain("secret-path");

    const pid = info.pid;
    await sidecar.stop();
    await sidecar.stop(); // idempotent
    expect(alive(pid)).toBe(false);
    expect(await isPortFree(info.port)).toBe(true);
    expect(sidecar.running).toBe(false);
  });

  it("keeps the token off the command line and out of the environment", async () => {
    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const spawnFn: SpawnFn = (command, args, options: SpawnOptions) => {
      seen.push({ args, env: options.env ?? {} });
      return spawn(command, args, options);
    };
    const { sidecar } = make("ok", { spawn: spawnFn });
    const info = await sidecar.start();
    await sidecar.stop();
    const [call] = seen;
    expect(call?.args.slice(-3)).toEqual(["--parent-pipe", "--port", String(info.port)]);
    expect(call?.args.join(" ")).not.toContain(info.token);
    expect(Object.values(call?.env ?? {}).join(" ")).not.toContain(info.token);
  });

  it("uses a fresh token per launch", async () => {
    const a = make("ok").sidecar;
    const b = make("ok").sidecar;
    const [ia, ib] = [await a.start(), await b.start()];
    await Promise.all([a.stop(), b.stop()]);
    expect(ia.token).not.toBe(ib.token);
  });

  it("redacts the token should the child ever print it", async () => {
    const { sidecar, lines } = make("leaky");
    const info = await sidecar.start();
    await vi.waitFor(() => expect(lines.join("\n")).toContain("debug: token <redacted>"));
    await sidecar.stop();
    expect(lines.join("\n")).not.toContain(info.token);
  });

  it("never takes a server without our token for ours", async () => {
    const { sidecar } = make("foreign", { startupTimeoutMs: 800 });
    const error = await sidecar.start().then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as Error).message).toMatch(/did not start within/);
    expect(sidecar.running).toBe(false);
  });

  it("escalates to SIGKILL when the child ignores the closed pipe", async () => {
    const { sidecar } = make("stubborn", { stopTimeoutMs: 300 });
    const info = await sidecar.start();
    await sidecar.stop();
    expect(alive(info.pid)).toBe(false);
  });

  it("reports a failed start with the child's last line and does not retry", async () => {
    const ports: (number | null | undefined)[] = [];
    const { sidecar } = make("exit-early", {
      choosePort: async (preferred) => {
        ports.push(preferred);
        return freePort();
      },
    });
    const error = await sidecar.start().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SidecarError);
    expect((error as Error).message).toMatch(/stopped during startup \(exit 3\)/);
    expect((error as Error).message).toContain("boom");
    expect(ports).toHaveLength(1);
    expect(sidecar.running).toBe(false);
  });

  it("gives up after the startup timeout and kills the child", async () => {
    const { sidecar } = make("hang", { startupTimeoutMs: 400, stopTimeoutMs: 1000 });
    const error = await sidecar.start().then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as Error).message).toMatch(/did not start within/);
    expect(sidecar.running).toBe(false);
  });

  it("retries on another port when the chosen one was taken before the child bound it", async () => {
    // Another process on the port (it drops every connection, so it never answers a probe).
    const taken = createServer((socket) => socket.destroy());
    const takenPort = await new Promise<number>((done) =>
      taken.listen(0, "127.0.0.1", () => done((taken.address() as AddressInfo).port)),
    );
    try {
      const ports: (number | null | undefined)[] = [];
      const { sidecar } = make("ok", {
        preferredPort: takenPort,
        // The race: the port was free when chosen, another process bound it before the child.
        choosePort: async (preferred) => {
          ports.push(preferred);
          return preferred ?? (await freePort());
        },
      });
      const info = await sidecar.start();
      expect(ports).toEqual([takenPort, null]);
      expect(info.port).not.toBe(takenPort);
      await sidecar.stop();
    } finally {
      await new Promise((done) => taken.close(done));
    }
  });

  it("tells the shell when the sidecar dies after it started", async () => {
    const messages: string[] = [];
    const { sidecar } = make("ok", { onExit: (m) => messages.push(m) });
    const info = await sidecar.start();
    process.kill(info.pid as number, "SIGKILL");
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatch(/stopped unexpectedly/);
    expect(sidecar.running).toBe(false);
  });
});

async function freePort(): Promise<number> {
  const { chooseLoopbackPort } = await import("./net.js");
  return chooseLoopbackPort();
}

describe("sidecar environment and command", () => {
  it("pins the data dir and drops anything that could inject or embed a token", () => {
    const env = buildSidecarEnv(
      {
        CASHU_DATA_DIR: "/real/data",
        CASHU_API_TOKEN: "injected",
        CASHU_PORT: "9",
        CASHU_DEV_EMBED_TOKEN: "1",
        ELECTRON_RUN_AS_NODE: "1",
        KEEP: "yes",
      },
      "/lab/demo",
    );
    expect(env.CASHU_DATA_DIR).toBe("/lab/demo");
    expect(env.CASHU_API_TOKEN).toBeUndefined();
    expect(env.CASHU_PORT).toBeUndefined();
    expect(env.CASHU_DEV_EMBED_TOKEN).toBe("");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.CASHU_HOST).toBe("127.0.0.1");
    expect(env.COLUMNS).toBeUndefined(); // nothing is parsed from the output any more
    expect(env.KEEP).toBe("yes");
  });

  it("appends the parent-pipe contract and the port", () => {
    expect(sidecarArgs({ command: "x", args: ["serve"], cwd: "/" }, 51234)).toEqual([
      "serve",
      "--parent-pipe",
      "--port",
      "51234",
    ]);
  });

  it("defaults to the checkout's venv and accepts an override", () => {
    expect(sidecarSpec("/repo", {})).toEqual({
      command: "/repo/.venv/bin/cashu",
      args: ["serve"],
      cwd: "/repo",
    });
    expect(
      sidecarSpec("/repo", {
        CASHU_DESKTOP_SIDECAR_BIN: "/repo/.venv/bin/python",
        CASHU_DESKTOP_SIDECAR_ARGS: '["frontend/e2e/serve_offline.py"]',
      }),
    ).toEqual({
      command: "/repo/.venv/bin/python",
      args: ["frontend/e2e/serve_offline.py"],
      cwd: "/repo",
    });
    expect(() => sidecarSpec("/repo", { CASHU_DESKTOP_SIDECAR_ARGS: '{"a":1}' })).toThrow(
      SidecarError,
    );
  });

  it("verifies that the sidecar resolves the data dir the shell chose", () => {
    const answer = (stdout: string, status = 0) =>
      (() => ({
        status,
        stdout,
        stderr: "boom",
        pid: 1,
        output: [],
        signal: null,
      })) as unknown as typeof spawnSync;
    const venv = { command: "/repo/.venv/bin/cashu", args: ["serve"], cwd: "/repo" };
    expect(verifyDataDir(venv, "/lab/demo", {}, answer("/lab/demo\n"))).toBeNull();
    expect(verifyDataDir(venv, "/lab/demo", {}, answer("/real/data\n"))).toMatch(/not \/lab\/demo/);
    expect(verifyDataDir(venv, "/lab/demo", {}, answer("", 1))).toMatch(/Could not ask/);
  });
});
