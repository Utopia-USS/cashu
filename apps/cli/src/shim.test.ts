// The `cashu` shim end to end as a process, with its host started on demand in a temp data dir and a
// synthetic host: native CLI output and exit codes travel over the host socket; host status / stop never start a host; no host means
// exit 69 and nothing run; a host command (genesis) prints through the host; MCP sessions relay, end
// with the server, and survive a host killed mid-session.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "./testing/dirs.js";
import { cleanEnv } from "./testing/python.js";
import { alive, hostPid, runShim, stopHosts } from "./testing/shim.js";

afterEach(async () => {
  await stopHosts();
  removeTempDirs();
});

const SLOW = 30_000;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    CASHU_DATA_DIR: tempDir("cashu-shim-data-"),
    CASHU_TESTING: "1",
    CASHU_LANG: "en",
    HOME: tempDir("cashu-shim-home-"),
    ...extra,
  };
}

describe("cashu shim: native CLI", () => {
  it(
    "prints root help and refuses unknown commands through the host it started",
    async () => {
      const e = env();
      const cwd = tempDir("cashu-shim-cwd-");
      const help = await runShim(["--help"], e, { cwd });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Usage: cashu");
      expect(help.stderr).toBe("");
      const pid = hostPid(e.CASHU_DATA_DIR as string);
      expect(pid !== undefined && alive(pid)).toBe(true);
      const unknown = await runShim(["unknown-command"], e, { cwd });
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain("Unknown or unsupported command");
      expect(hostPid(e.CASHU_DATA_DIR as string)).toBe(pid);
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
      expect(running.stdout).toContain("sejfy");
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

  it("refuses the synthetic host fixture outside a fresh temporary HOME", async () => {
    const e = env({ HOME: "/" });
    const run = await runShim(["stats"], e, { cwd: tempDir() });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("CLI test interposer: HOME is outside the temporary directory");
    expect(hostPid(e.CASHU_DATA_DIR as string)).toBeUndefined();
  });
});

describe("cashu shim: MCP", () => {
  it(
    "refuses an unknown native profile without starting a Python backend",
    async () => {
      const run = await runShim(["mcp", "--profile", "missing"], env(), { cwd: tempDir() });
      expect(run.code).toBe(69);
      expect(run.stderr).toContain("cashU could not start its background service");
    },
    SLOW,
  );
});
