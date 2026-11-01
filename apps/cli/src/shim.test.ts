// The `cashu` shim end to end as a process, with its host started on demand in a temp data dir and a
// stand-in for the Python CLI (apps/host/test-fixtures; CI has no Python): delegation keeps argv, cwd,
// env, stdin, exit codes, signals and terminals; host status / stop never start a host; no host means
// exit 69 and nothing run; a host command (genesis) prints through the host; MCP sessions relay, end
// with the server, and survive a host killed mid-session.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "./testing/dirs.js";
import { cleanEnv } from "./testing/python.js";
import {
  alive,
  FAKE_PYTHON,
  hostPid,
  NODE_ARGS,
  runShim,
  spawnShim,
  stopHosts,
} from "./testing/shim.js";

afterEach(async () => {
  await stopHosts();
  removeTempDirs();
});

const SLOW = 30_000;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    CASHU_DATA_DIR: tempDir("cashu-shim-data-"),
    CASHU_PYTHON_CLI: FAKE_PYTHON,
    CASHU_TESTING: "1",
    CASHU_LANG: "en",
    HOME: tempDir("cashu-shim-home-"),
    ...extra,
  };
}

const HAS_PYTHON3 = spawnSync("python3", ["-c", "import pty"]).status === 0;

describe("cashu shim: delegation", () => {
  it(
    "runs a Python command with the same argv, cwd, env and exit code, through a host it started",
    async () => {
      const e = env({ CASHU_MARK: "x" });
      const cwd = tempDir("cashu-shim-cwd-");
      const run = await runShim(["--profile", "demo-anna", "stats", "--months", "3"], e, { cwd });
      expect([run.code, run.stderr]).toEqual([0, "fake cli: done\n"]);
      const seen = JSON.parse(run.stdout);
      expect(seen.argv).toEqual(["--profile", "demo-anna", "stats", "--months", "3"]);
      expect(seen.cwd).toBe(cwd);
      expect(seen.env).toMatchObject({ CASHU_MARK: "x", CASHU_DATA_DIR: e.CASHU_DATA_DIR });
      expect(seen.tty).toEqual([false, false, false]);
      const pid = hostPid(e.CASHU_DATA_DIR as string);
      expect(pid !== undefined && alive(pid)).toBe(true);
      expect((await runShim(["exit", "7"], e, { cwd })).code).toBe(7);
      expect(hostPid(e.CASHU_DATA_DIR as string)).toBe(pid);
      const echoed = await runShim(["stdin"], e, { cwd, input: "line 1\nzażółć\n" });
      expect(echoed.stdout).toBe("line 1\nzażółć\n");
      const killed = await runShim(["signal"], e, { cwd });
      expect([killed.code, killed.signal]).toEqual([null, "SIGTERM"]);
    },
    SLOW,
  );

  it.skipIf(!HAS_PYTHON3)(
    "hands the delegated command the shim's terminal",
    async () => {
      const e = env();
      const pty = spawnSync(
        "python3",
        ["-c", "import pty, sys; pty.spawn(sys.argv[1:])", process.execPath, ...NODE_ARGS, "show"],
        { env: e, encoding: "utf8", cwd: tempDir() },
      );
      const json = pty.stdout.split(/\r?\n/).find((l) => l.startsWith("{"));
      expect(JSON.parse(json ?? "{}").tty).toEqual([true, true, true]);
    },
    SLOW,
  );

  it(
    "runs a host command in the host (genesis usage, exit 64)",
    async () => {
      const run = await runShim(["genesis"], env(), { cwd: tempDir() });
      expect(run.code).toBe(64);
      expect(run.stderr).toMatch(/^genesis: usage: cashu genesis --data-dir/);
      expect(run.stdout).toBe("genesis: exit 64\n");
    },
    SLOW,
  );
});

describe("cashu shim: host admin and failures", () => {
  it(
    "host status / stop never start a host",
    async () => {
      const e = env({ CASHU_LANG: "pl" });
      const cwd = tempDir();
      const status = await runShim(["host", "status"], e, { cwd });
      expect([status.code, status.stdout]).toEqual([3, "Usługa cashU w tle nie działa.\n"]);
      expect(hostPid(e.CASHU_DATA_DIR as string)).toBeUndefined();
      await runShim(["anything"], e, { cwd });
      const running = await runShim(["host", "status"], e, { cwd });
      expect(running.code).toBe(0);
      expect(running.stdout).toMatch(/^Usługa cashU w tle działa \(pid \d+/);
      const pid = hostPid(e.CASHU_DATA_DIR as string) as number;
      expect((await runShim(["host", "stop"], e, { cwd })).code).toBe(0);
      for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
      expect(alive(pid)).toBe(false);
      expect((await runShim(["host", "bogus"], e, { cwd })).code).toBe(64);
    },
    SLOW,
  );

  it(
    "says the background service is unavailable (exit 69) and runs nothing when no host can start",
    async () => {
      const blocker = join(tempDir(), "file");
      writeFileSync(blocker, "");
      const e = env({ CASHU_DATA_DIR: join(blocker, "data") });
      const run = await runShim(["stats"], e, { cwd: tempDir() });
      expect(run.code).toBe(69);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/^cashU could not start its background service\./);
    },
    SLOW,
  );
});

/** An MCP client over a shim process: send messages, await lines. */
function mcpClient(e: NodeJS.ProcessEnv, cwd: string, profile = "demo-anna") {
  const child = spawnShim(["mcp", "--profile", profile], e, cwd);
  const lines: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (d: string) => {
    stderr += d;
  });
  createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (l) => {
    lines.push(JSON.parse(l));
    for (const w of waiters.splice(0)) w();
  });
  const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    send: (m: unknown) => child.stdin?.write(`${JSON.stringify(m)}\n`),
    async next(pred: (m: Record<string, unknown>) => boolean) {
      for (;;) {
        const i = lines.findIndex(pred);
        if (i !== -1) return lines.splice(i, 1)[0] as Record<string, unknown>;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    end: () => child.stdin?.end(),
    exit,
    stderr: () => stderr,
  };
}

describe("cashu shim: MCP", () => {
  it(
    "relays a session that survives the host being killed",
    async () => {
      const e = env();
      const cwd = tempDir("cashu-mcp-cwd-");
      const c = mcpClient(e, cwd);
      c.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "v" } });
      const init = (await c.next((m) => m.id === 0)) as { result: { capabilities: unknown } };
      expect(init.result.capabilities).toEqual({ tools: { listChanged: true } });
      c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      c.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const before = await c.next((m) => m.id === 1);
      c.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo" } });
      const echo = (await c.next((m) => m.id === 2)) as {
        result: { content: { text: string }[] };
      };
      expect(JSON.parse(echo.result.content[0]?.text ?? "{}").cwd).toBe(cwd);
      const first = hostPid(e.CASHU_DATA_DIR as string) as number;
      process.kill(first, "SIGKILL");
      await c.next((m) => m.method === "notifications/tools/list_changed");
      c.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
      const after = await c.next((m) => m.id === 3);
      expect(after.result).toEqual(before.result);
      const second = hostPid(e.CASHU_DATA_DIR as string) as number;
      expect(second).not.toBe(first);
      c.end();
      expect(await c.exit).toBe(0);
      expect(c.stderr()).toContain("fake mcp: serving demo-anna\n");
    },
    SLOW,
  );

  it(
    "exits with the server's code when it ends on its own (an unknown profile)",
    async () => {
      const c = mcpClient(env(), tempDir(), "missing");
      expect(await c.exit).toBe(1);
      expect(c.stderr()).toBe("No profile 'missing'. Profiles: demo.\n");
    },
    SLOW,
  );
});
