/// <reference types="node" />
import { type SpawnOptions, spawn, type spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPortFree } from "./net.js";
import {
  buildSidecarEnv,
  Sidecar,
  SidecarError,
  type SpawnFn,
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

describe("sidecar start and stop (shell.ServerThread)", () => {
  it("starts on a free port, learns the token and stops the child", async () => {
    const { sidecar, lines } = make("ok");
    const info = await sidecar.start();
    expect(info.port).toBeGreaterThan(1023);
    expect(info.origin).toBe(`http://127.0.0.1:${info.port}`);
    expect(info.url).toBe(`${info.origin}/`);
    expect(info.token).toBe("fakeToken_0123456789abcdefghijklmnop");
    expect(sidecar.running).toBe(true);
    expect(await (await fetch(info.url)).text()).toContain("<html>");

    // The token and the request log never reach the log.
    expect(lines.join("\n")).not.toContain(info.token);
    expect(lines.join("\n")).toContain("#token=<redacted>");
    expect(lines.join("\n")).not.toContain("secret-path");

    const pid = info.pid;
    await sidecar.stop();
    await sidecar.stop(); // idempotent
    expect(alive(pid)).toBe(false);
    expect(await isPortFree(info.port)).toBe(true);
    expect(sidecar.running).toBe(false);
  });

  it("escalates to SIGKILL when the child ignores SIGINT", async () => {
    const { sidecar } = make("stubborn", { stopTimeoutMs: 300 });
    const info = await sidecar.start();
    await sidecar.stop();
    expect(alive(info.pid)).toBe(false);
  });

  it("reports a failed start with the child's last line", async () => {
    const { sidecar } = make("exit-early");
    const error = await sidecar.start().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SidecarError);
    expect((error as Error).message).toMatch(/stopped during startup \(exit 3\)/);
    expect((error as Error).message).toContain("boom");
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

  it("retries on another port when its own child could not bind", async () => {
    const modes = ["busy", "ok"];
    let attempt = 0;
    const spawnFn: SpawnFn = (command, args, options: SpawnOptions) =>
      spawn(command, args, {
        ...options,
        env: { ...options.env, FAKE_MODE: modes[attempt++] ?? "ok" },
      });
    const ports: (number | null | undefined)[] = [];
    const { sidecar } = make("ok", {
      spawn: spawnFn,
      preferredPort: 51111,
      choosePort: async (preferred) => {
        ports.push(preferred);
        return preferred ? 51111 : await freePort();
      },
    });
    const info = await sidecar.start();
    expect(attempt).toBe(2);
    expect(ports).toEqual([51111, null]);
    expect(info.port).not.toBe(51111);
    await sidecar.stop();
  });

  it("tells the shell when the sidecar dies after it started", async () => {
    const messages: string[] = [];
    const { sidecar } = make("ok", { onExit: (m) => messages.push(m) });
    const info = await sidecar.start();
    process.kill(info.pid as number, "SIGKILL");
    await new Promise((done) => setTimeout(done, 300));
    expect(messages).toHaveLength(1);
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
    expect(env.KEEP).toBe("yes");
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
