import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemdFiles, SystemdRunner } from "./systemd.js";
import {
  quoteSystemdArg,
  SYSTEMD_SERVICE,
  SYSTEMD_TIMER,
  SystemdHostService,
  systemdUnitTexts,
} from "./systemd.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cashu-service-test-")));
  roots.push(home);
  const dataDir = join(home, ".local", "share", "cashu");
  const unitDir = join(home, ".config", "systemd", "user");
  const calls: string[][] = [];
  let enabled = false;
  let fail = "";
  const runner: SystemdRunner = {
    async run(args) {
      calls.push([...args]);
      if (args[1] === fail) return { code: 1, stdout: "" };
      if (args[1] === "enable") enabled = true;
      if (args[1] === "disable") enabled = false;
      if (args[1] === "is-enabled") {
        return { code: enabled ? 0 : 1, stdout: enabled ? "enabled\n" : "disabled\n" };
      }
      return { code: 0, stdout: "" };
    },
  };
  return {
    home,
    dataDir,
    unitDir,
    calls,
    setFailure: (command: string) => {
      fail = command;
    },
    service: new SystemdHostService({ home, dataDir, runner }),
  };
}

describe("systemd user service adapter", () => {
  it("writes exact on-demand units and enables only the timer", async () => {
    const f = await fixture();
    expect(await f.service.enable()).toEqual({ state: "enabled" });
    expect(await readFile(join(f.unitDir, SYSTEMD_SERVICE), "utf8")).toContain(
      'ExecStart="/usr/libexec/cashu-host" "run" "--data-dir"',
    );
    const timer = await readFile(join(f.unitDir, SYSTEMD_TIMER), "utf8");
    expect(timer).toContain("OnCalendar=*-*-* 07:30:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).not.toContain("KeepAlive");
    expect(f.calls).toContainEqual(["--user", "enable", "--now", SYSTEMD_TIMER]);
    expect(f.calls).not.toContainEqual(["--user", "enable", SYSTEMD_SERVICE]);
    expect(await f.service.start()).toEqual({ kind: "started" });
    expect(f.calls).toContainEqual(["--user", "start", SYSTEMD_SERVICE]);
  });

  it("refuses custom data directories and control characters", async () => {
    const f = await fixture();
    const custom = new SystemdHostService({
      home: f.home,
      dataDir: join(f.home, "custom"),
      runner: { run: async () => ({ code: 0, stdout: "" }) },
    });
    expect((await custom.enable()).state).toBe("error");
    expect(f.calls).toEqual([]);
    expect(() => quoteSystemdArg("bad\nvalue")).toThrow();
    expect(() => systemdUnitTexts("/tmp/bad\npath")).toThrow();
    expect(quoteSystemdArg('/tmp/a % "b"')).toBe('"/tmp/a %% \\"b\\""');
    expect(quoteSystemdArg("/tmp/$HOME/${HOME}")).toBe('"/tmp/$$HOME/$${HOME}"');
  });

  it("preserves a literal dollar in the canonical data directory", async () => {
    const f = await fixture();
    const home = join(f.home, "$owner");
    await mkdir(home);
    const dataDir = join(home, ".local", "share", "cashu");
    const service = new SystemdHostService({
      home,
      dataDir,
      runner: {
        run: async (args) =>
          args[1] === "is-enabled" ? { code: 0, stdout: "enabled" } : { code: 0, stdout: "" },
      },
    });
    expect((await service.enable()).state).toBe("enabled");
    const unit = await readFile(join(home, ".config", "systemd", "user", SYSTEMD_SERVICE), "utf8");
    expect(unit).toContain("/$$owner/");
  });

  it("rejects a missing unit directory under a symlink ancestor before writing", async () => {
    const f = await fixture();
    const target = join(f.home, "outside");
    await mkdir(target);
    await symlink(target, join(f.home, ".config"));
    expect((await f.service.enable()).state).toBe("error");
    expect(await readdir(target)).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("rejects unsafe modes and hardlinks before systemctl mutation", async () => {
    const f = await fixture();
    await f.service.enable();
    f.calls.length = 0;
    const path = join(f.unitDir, SYSTEMD_SERVICE);
    await chmod(path, 0o666);
    expect(await f.service.disable()).toEqual({ state: "error", reason: "foreign_unit" });
    expect(f.calls).toEqual([]);
    await chmod(path, 0o600);
    await link(path, join(f.unitDir, "other-link"));
    expect(await f.service.disable()).toEqual({ state: "error", reason: "foreign_unit" });
    expect(f.calls).toEqual([]);
  });

  it("freezes runtime paths and runner method at construction", async () => {
    const f = await fixture();
    const originalRun = async (args: readonly string[]) => {
      f.calls.push([...args]);
      return { code: 0, stdout: args[1] === "is-enabled" ? "enabled" : "" };
    };
    const runner = { run: originalRun };
    const runtime = { home: f.home, dataDir: f.dataDir, runner };
    const service = new SystemdHostService(runtime);
    runtime.dataDir = join(f.home, "other");
    runner.run = async () => {
      throw Error("rebound runner");
    };
    expect((await service.enable()).state).toBe("enabled");
    expect(f.calls).toContainEqual(["--user", "enable", "--now", SYSTEMD_TIMER]);
  });

  it("will not replace or delete foreign and symlinked unit files", async () => {
    const f = await fixture();
    await f.service.enable();
    const foreign = join(f.unitDir, SYSTEMD_SERVICE);
    await writeFile(foreign, "[Service]\nExecStart=/bin/false\n");
    expect(await f.service.disable()).toEqual({ state: "error", reason: "foreign_unit" });
    expect(await readFile(foreign, "utf8")).toContain("/bin/false");
    expect(f.calls).not.toContainEqual(["--user", "disable", "--now", SYSTEMD_TIMER]);
    await rm(foreign);
    await symlink("/bin/false", foreign);
    expect(await f.service.enable()).toEqual({ state: "error", reason: "foreign_unit" });
  });

  it("reports partial enable failure and leaves owned files for repair", async () => {
    const f = await fixture();
    f.setFailure("enable");
    expect(await f.service.enable()).toEqual({ state: "error", reason: "enable_failed" });
    expect(await readFile(join(f.unitDir, SYSTEMD_TIMER), "utf8")).toContain("Persistent=true");
    f.setFailure("");
    expect((await f.service.enable()).state).toBe("enabled");
    expect((await f.service.disable()).state).toBe("off");
  });

  it("rechecks service ownership after timer unlink before service unlink", async () => {
    const f = await fixture();
    await f.service.enable();
    const servicePath = join(f.unitDir, SYSTEMD_SERVICE);
    const timerPath = join(f.unitDir, SYSTEMD_TIMER);
    const fs = {
      ...nodeFs,
      rm: (async (path: string, options?: { force?: boolean }) => {
        await nodeFs.rm(path, options);
        if (path === timerPath) await nodeFs.writeFile(servicePath, "foreign service\n");
      }) as typeof nodeFs.rm,
    } satisfies SystemdFiles;
    const service = new SystemdHostService({
      home: f.home,
      dataDir: f.dataDir,
      runner: { run: async () => ({ code: 0, stdout: "" }) },
      fs,
    });
    expect(await service.disable()).toEqual({ state: "error", reason: "foreign_unit" });
    expect(await readFile(servicePath, "utf8")).toBe("foreign service\n");
  });

  it("stops publication if unit directory swaps after the missing-file probe", async () => {
    const f = await fixture();
    await mkdir(f.unitDir, { recursive: true });
    const servicePath = join(f.unitDir, SYSTEMD_SERVICE);
    const moved = join(f.home, "moved-units");
    const target = join(f.home, "outside");
    await mkdir(target);
    let probes = 0;
    const fs = {
      ...nodeFs,
      open: (async (path: string, flags: string | number, mode?: number) => {
        if (path === servicePath && ++probes === 2) {
          await nodeFs.rename(f.unitDir, moved);
          await nodeFs.symlink(target, f.unitDir);
        }
        return nodeFs.open(path, flags, mode);
      }) as typeof nodeFs.open,
    } satisfies SystemdFiles;
    const service = new SystemdHostService({
      home: f.home,
      dataDir: f.dataDir,
      runner: { run: async () => ({ code: 0, stdout: "" }) },
      fs,
    });
    expect((await service.enable()).state).toBe("error");
    expect(await readdir(target)).toEqual([]);
  });

  it("rejects a FIFO unit without a blocking open", async () => {
    const f = await fixture();
    await f.service.enable();
    const servicePath = join(f.unitDir, SYSTEMD_SERVICE);
    await rm(servicePath);
    execFileSync("/usr/bin/mkfifo", [servicePath]);
    let observed = 0;
    const fs = {
      ...nodeFs,
      open: (async (path: string, flags: string | number, mode?: number) => {
        if (path === servicePath) {
          observed = Number(flags);
          if (!(observed & constants.O_NONBLOCK)) throw Error("blocking FIFO open refused by test");
        }
        return nodeFs.open(path, flags, mode);
      }) as typeof nodeFs.open,
    } satisfies SystemdFiles;
    const service = new SystemdHostService({
      home: f.home,
      dataDir: f.dataDir,
      runner: { run: async () => ({ code: 0, stdout: "" }) },
      fs,
    });
    expect(await service.status()).toEqual({ state: "error", reason: "foreign_unit" });
    expect(observed & constants.O_NONBLOCK).not.toBe(0);
  });
});
