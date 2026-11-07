import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HostService, ServiceStatus, StartOutcome } from "./types.js";

export const SYSTEMD_SERVICE = "io.utopiasoft.cashu.host.service";
export const SYSTEMD_TIMER = "io.utopiasoft.cashu.host.timer";
/** S47 must ship and bind this exact launcher before enabling production registration. */
export const SYSTEMD_LAUNCHER = "/usr/libexec/cashu-host";
const OWNED = "# cashU host service v1 (managed by cashU)";

export interface SystemdRunner {
  run(args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }>;
}

export interface SystemdFiles {
  mkdir: typeof nodeFs.mkdir;
  lstat: typeof nodeFs.lstat;
  open: typeof nodeFs.open;
  rename: typeof nodeFs.rename;
  rm: typeof nodeFs.rm;
  realpath: typeof nodeFs.realpath;
}

export interface SystemdRuntime {
  readonly home: string;
  readonly dataDir: string;
  readonly xdgConfigHome?: string;
  readonly xdgDataHome?: string;
  readonly fs?: SystemdFiles;
  readonly runner: SystemdRunner;
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function cleanAbsolute(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path && !hasControl(path);
}

/** systemd ExecStart word quoting, including specifier and environment expansion escaping. */
export function quoteSystemdArg(arg: string): string {
  if (!cleanAbsolute(arg) && (arg.startsWith("/") || hasControl(arg))) {
    throw Error("unsafe systemd argument");
  }
  return `"${arg
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}

export function systemdUnitTexts(dataDir: string): { service: string; timer: string } {
  if (!cleanAbsolute(dataDir)) throw Error("unsafe data directory");
  const service = `${OWNED}\n[Unit]\nDescription=cashU on-demand host\n\n[Service]\nType=exec\nExecStart=${quoteSystemdArg(SYSTEMD_LAUNCHER)} "run" "--data-dir" ${quoteSystemdArg(dataDir)}\n`;
  const timer = `${OWNED}\n[Unit]\nDescription=cashU daily host wake\n\n[Timer]\nOnCalendar=*-*-* 07:30:00\nPersistent=true\nUnit=${SYSTEMD_SERVICE}\n\n[Install]\nWantedBy=timers.target\n`;
  return { service, timer };
}

type FileState = "missing" | "owned" | "foreign";

export class SystemdHostService implements HostService {
  readonly #o: Readonly<Pick<SystemdRuntime, "home" | "dataDir" | "xdgConfigHome" | "xdgDataHome">>;
  readonly #fs: SystemdFiles;
  readonly #run: SystemdRunner["run"];

  constructor(runtime: SystemdRuntime) {
    this.#o = Object.freeze({
      home: runtime.home,
      dataDir: runtime.dataDir,
      xdgConfigHome: runtime.xdgConfigHome,
      xdgDataHome: runtime.xdgDataHome,
    });
    const fs = runtime.fs ?? nodeFs;
    this.#fs = Object.freeze({
      mkdir: fs.mkdir.bind(fs),
      lstat: fs.lstat.bind(fs),
      open: fs.open.bind(fs),
      rename: fs.rename.bind(fs),
      rm: fs.rm.bind(fs),
      realpath: fs.realpath.bind(fs),
    }) as SystemdFiles;
    this.#run = runtime.runner.run.bind(runtime.runner);
  }

  #paths() {
    const { home, dataDir, xdgConfigHome, xdgDataHome } = this.#o;
    if (
      ![home, dataDir, xdgConfigHome, xdgDataHome]
        .filter((v) => v !== undefined)
        .every(cleanAbsolute)
    ) {
      throw Error("unsafe runtime path");
    }
    const expectedDataDir = join(xdgDataHome ?? join(home, ".local", "share"), "cashu");
    if (dataDir !== expectedDataDir) throw Error("custom data directory cannot register a service");
    const configRoot = xdgConfigHome ?? join(home, ".config");
    for (const root of [configRoot, xdgDataHome ?? join(home, ".local", "share")]) {
      const rel = relative(home, root);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw Error("service roots must stay inside home");
      }
    }
    const unitDir = join(configRoot, "systemd", "user");
    const dirs = [home];
    let current = home;
    for (const part of relative(home, unitDir).split(sep)) {
      current = join(current, part);
      dirs.push(current);
    }
    return {
      unitDir,
      dirs,
      service: join(unitDir, SYSTEMD_SERVICE),
      timer: join(unitDir, SYSTEMD_TIMER),
    };
  }

  async #directories(dirs: readonly string[], create: boolean): Promise<boolean> {
    const uid = process.getuid?.();
    if (uid === undefined) throw Error("user identity unavailable");
    for (const dir of dirs) {
      let created = false;
      let stat: Awaited<ReturnType<SystemdFiles["lstat"]>>;
      try {
        stat = await this.#fs.lstat(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!create) return false;
        await this.#fs.mkdir(dir, { mode: 0o700 });
        created = true;
        stat = await this.#fs.lstat(dir);
      }
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== uid ||
        (stat.mode & 0o022) !== 0
      ) {
        throw Error("unsafe unit directory");
      }
      if ((await this.#fs.realpath(dir)) !== dir) throw Error("symlink unit ancestor");
      if (created) await this.#syncDirectory(dirname(dir));
    }
    return true;
  }

  async #state(path: string, content: string): Promise<FileState> {
    let handle: Awaited<ReturnType<SystemdFiles["open"]>>;
    try {
      handle = await this.#fs.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      if ((error as NodeJS.ErrnoException).code === "ELOOP") return "foreign";
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o022) !== 0
      )
        return "foreign";
      return (await handle.readFile("utf8")) === content ? "owned" : "foreign";
    } finally {
      await handle.close();
    }
  }

  async #inventory() {
    const paths = this.#paths();
    const hasUnitDir = await this.#directories(paths.dirs, false);
    try {
      if ((await this.#fs.realpath(this.#o.dataDir)) !== this.#o.dataDir) {
        throw Error("symlink data directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const content = systemdUnitTexts(this.#o.dataDir);
    if (!hasUnitDir)
      return { paths, content, service: "missing" as const, timer: "missing" as const };
    const [service, timer] = await Promise.all([
      this.#state(paths.service, content.service),
      this.#state(paths.timer, content.timer),
    ]);
    return { paths, content, service, timer };
  }

  async #command(...args: string[]): Promise<boolean> {
    const result = await this.#run(["--user", ...args]);
    return result.code === 0;
  }

  async status(): Promise<ServiceStatus> {
    try {
      const inventory = await this.#inventory();
      if (inventory.service === "foreign" || inventory.timer === "foreign") {
        return { state: "error", reason: "foreign_unit" };
      }
      if (inventory.service === "missing" && inventory.timer === "missing") return { state: "off" };
      if (inventory.service !== "owned" || inventory.timer !== "owned") {
        return { state: "error", reason: "partial_units" };
      }
      const enabled = await this.#run(["--user", "is-enabled", SYSTEMD_TIMER]);
      if (enabled.code === 0 && enabled.stdout.trim() === "enabled") return { state: "enabled" };
      if (enabled.stdout.trim() === "disabled") return { state: "off" };
      return { state: "unavailable", reason: "user_manager" };
    } catch {
      return { state: "error", reason: "status_failed" };
    }
  }

  async #writeOwned(path: string, content: string): Promise<void> {
    const state = await this.#state(path, content);
    if (state === "foreign") throw Error("foreign unit");
    if (state === "owned") return;
    if (!(await this.#directories(this.#paths().dirs, false)))
      throw Error("unit directory vanished");
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await this.#fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await this.#state(path, content)) !== "missing")
        throw Error("unit changed during write");
      if (!(await this.#directories(this.#paths().dirs, false)))
        throw Error("unit directory changed");
      await this.#fs.rename(temp, path);
      await this.#syncDirectory(this.#paths().unitDir);
    } finally {
      await this.#fs.rm(temp, { force: true });
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    const handle = await this.#fs.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #requireOwnedPair() {
    const inventory = await this.#inventory();
    if (inventory.service !== "owned" || inventory.timer !== "owned") {
      throw Error("unit ownership changed");
    }
    return inventory;
  }

  async enable(): Promise<ServiceStatus> {
    try {
      const inventory = await this.#inventory();
      if (inventory.service === "foreign" || inventory.timer === "foreign") {
        return { state: "error", reason: "foreign_unit" };
      }
      await this.#directories(inventory.paths.dirs, true);
      await this.#writeOwned(inventory.paths.service, inventory.content.service);
      await this.#writeOwned(inventory.paths.timer, inventory.content.timer);
      await this.#requireOwnedPair();
      if (!(await this.#command("daemon-reload")))
        return { state: "error", reason: "reload_failed" };
      await this.#requireOwnedPair();
      if (!(await this.#command("enable", "--now", SYSTEMD_TIMER))) {
        return { state: "error", reason: "enable_failed" };
      }
      return this.status();
    } catch {
      return { state: "error", reason: "enable_failed" };
    }
  }

  async disable(): Promise<ServiceStatus> {
    try {
      const inventory = await this.#inventory();
      if (inventory.service === "foreign" || inventory.timer === "foreign") {
        return { state: "error", reason: "foreign_unit" };
      }
      if (inventory.service === "missing" && inventory.timer === "missing") return { state: "off" };
      await this.#requireOwnedPair();
      if (!(await this.#command("disable", "--now", SYSTEMD_TIMER))) {
        return { state: "error", reason: "disable_failed" };
      }
      // Recheck each file before unlinking. Never remove a replaced or symlinked unit.
      await this.#requireOwnedPair();
      await this.#fs.rm(inventory.paths.timer);
      if (!(await this.#directories(inventory.paths.dirs, false)))
        throw Error("unit directory changed");
      if ((await this.#state(inventory.paths.service, inventory.content.service)) !== "owned") {
        return { state: "error", reason: "foreign_unit" };
      }
      await this.#fs.rm(inventory.paths.service);
      await this.#syncDirectory(inventory.paths.unitDir);
      const after = await this.#inventory();
      if (after.service !== "missing" || after.timer !== "missing") {
        return { state: "error", reason: "units_changed" };
      }
      if (!(await this.#command("daemon-reload")))
        return { state: "error", reason: "reload_failed" };
      return this.status();
    } catch {
      return { state: "error", reason: "disable_failed" };
    }
  }

  async start(): Promise<StartOutcome> {
    if ((await this.status()).state !== "enabled") return { kind: "unavailable" };
    try {
      await this.#requireOwnedPair();
      return (await this.#command("start", SYSTEMD_SERVICE))
        ? { kind: "started" }
        : { kind: "failed", reason: "start_failed" };
    } catch {
      return { kind: "failed", reason: "start_failed" };
    }
  }
}
