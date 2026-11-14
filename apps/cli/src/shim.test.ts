// The `cashu` shim end to end as a process, with its host started on demand in a temp data dir and a
// synthetic host: native CLI output and exit codes travel over the host socket; host status / stop
// never start a host; no host means exit 69 and nothing run; a host still opening its stores is waited
// for, past the no-host bound, and not raced; a failure the shim has no text for is named; an unknown
// MCP profile is refused. A host command run through the shim is skills.test.ts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHost } from "@cashu/node-host";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "./testing/dirs.js";
import { cleanEnv } from "./testing/env.js";
import {
  alive,
  hostPid,
  runShim,
  SHIM_TEST_TIMEOUT_MS as SLOW,
  stopHosts,
} from "./testing/shim.js";

afterEach(async () => {
  await stopHosts();
  removeTempDirs();
});

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
    "says why no host could be reached (exit 69) and runs nothing",
    async () => {
      const blocker = join(tempDir(), "file");
      writeFileSync(blocker, "");
      const e = env({ CASHU_DATA_DIR: join(blocker, "data") });
      const run = await runShim(["stats"], e, { cwd: tempDir() });
      expect(run.code).toBe(69);
      expect(run.stdout).toBe("");
      // The text names what failed: the data dir cannot hold the host's run dir.
      expect(run.stderr).toMatch(
        /^cashU could not reach its background service \(Error: ENOTDIR: not a directory, .*host\.token'\)\./,
      );
    },
    SLOW,
  );

  it("waits for a host that is still starting, then runs the command on it; names an unknown failure", async () => {
    const e = env();
    const cwd = tempDir();
    // A protocol-level host in this process: starting until `ready()`, then it serves `cli.exec`
    // with fixed output and closes every admin session before answering.
    const host = await startHost({
      dataDir: e.CASHU_DATA_DIR as string,
      build: "dev",
      features: ["cli.exec"],
      starting: true,
      onSession: (session) => {
        if (session.role !== "cli") return session.close();
        session.onFrame((frame) => {
          if (frame.t !== "req" || frame.method !== "cli.exec") return;
          const note = { stream: "stdout", data: "served\n" };
          session.send({ t: "note", id: frame.id, method: "cli.out", params: note });
          const exit = { kind: "exit", code: 0 };
          session.send({ t: "res", id: frame.id, outcome: { ok: true, result: exit } });
        });
      },
    });
    try {
      const status = await runShim(["host", "status"], e, { cwd });
      expect([status.code, status.stdout]).toEqual([
        0,
        `The cashU background service is starting (pid ${process.pid}, opening the vaults); commands wait until it is ready.\n`,
      ]);
      // Ready only after the 10 s a client gives a host that does not answer at all.
      const run = runShim(["stats"], e, { cwd });
      await new Promise((r) => setTimeout(r, 14_000));
      host.ready();
      const served = await run;
      expect([served.code, served.stdout, served.stderr]).toEqual([0, "served\n", ""]);
      // Nobody started a second host meanwhile.
      expect(hostPid(e.CASHU_DATA_DIR as string)).toBe(process.pid);

      const lost = await runShim(["host", "status"], e, { cwd });
      expect(lost.code).toBe(69);
      expect(lost.stderr).toMatch(
        /^cashU could not reach its background service \(Error: the host connection closed\)\./,
      );
    } finally {
      await host.close();
    }
  }, 45_000);

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
    "refuses an unknown native profile",
    async () => {
      const run = await runShim(["mcp", "--profile", "missing"], env(), { cwd: tempDir() });
      expect(run.code).toBe(69);
      expect(run.stderr).toContain(
        "cashU could not reach its background service (HostCallError: no MCP server in this build)",
      );
    },
    SLOW,
  );
});
