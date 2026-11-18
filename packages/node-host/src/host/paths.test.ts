import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir, trackDir } from "../testing/hostHarness.js";
import { linkDir } from "../testing/links.js";
import {
  assertSocketPath,
  ensurePrivateDir,
  HostPathError,
  type HostRunPaths,
  hostPipeName,
  hostRunPaths,
  isHostPipeName,
  MAX_SOCKET_PATH_BYTES,
  type UnixSocketRunPaths,
} from "./paths.js";

afterEach(cleanup);

// Skips POSIX-only cases on Windows, where file modes are synthetic. Directory links are junctions
// there (`linkDir`), so link cases run on every platform.
const ON_WINDOWS = process.platform === "win32";

/** The paths of a Unix socket host (macOS / Linux), else a failed test. */
function unix(paths: HostRunPaths): UnixSocketRunPaths {
  if (paths.transport !== "unix-socket") throw new Error("expected a Unix socket host");
  return paths;
}

describe("host run paths", () => {
  it("puts everything under <data dir>/run, named by the data dir's real path", () => {
    const base = trackDir(tempDir());
    const data = join(base, "data");
    mkdirSync(data);
    const p = unix(hostRunPaths(data, { platform: "darwin" }));
    expect(p.runDir).toBe(join(data, "run"));
    expect(p.socketPath).toBe(join(data, "run", "host.sock"));
    expect(p.socketDir).toBe(p.runDir);
    expect(p.lockPath).toBe(join(data, "run", "host.lock.db"));
    expect(p.logPath).toBe(join(data, "logs", "host.log"));
    expect(p.dataDirId).toMatch(/^[0-9a-f]{64}$/);
    // Another data dir is another host.
    expect(hostRunPaths(join(base, "other")).dataDirId).not.toBe(p.dataDirId);
  });

  // A directory link: a junction on Windows (no privilege needed), a symlink elsewhere.
  it("names the same data dir through a directory link as the same host", () => {
    const base = trackDir(tempDir());
    const data = join(base, "data");
    mkdirSync(data);
    linkDir(data, join(base, "link"));
    expect(hostRunPaths(join(base, "link")).dataDirId).toBe(hostRunPaths(data).dataDirId);
  });

  // Every process must derive one id from any spelling of the data dir: the native realpath gives the
  // on-disk case and long names, so the case and an 8.3 short name of the same folder agree.
  it.skipIf(!ON_WINDOWS)(
    "names the same data dir as the same host from another letter case or its 8.3 name",
    (ctx) => {
      const data = join(trackDir(tempDir()), "Long Data Directory");
      mkdirSync(data);
      const id = hostRunPaths(data).dataDirId;
      expect(hostRunPaths(data.toUpperCase()).dataDirId).toBe(id);
      expect(hostRunPaths(data.toLowerCase()).dataDirId).toBe(id);
      const cmd = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      const short = spawnSync(cmd, ["/d", "/s", "/c", `"for %I in ("${data}") do @echo %~sI"`], {
        windowsVerbatimArguments: true,
        encoding: "utf8",
      }).stdout.trim();
      // A volume with 8.3 name generation disabled has no short name to compare.
      if (short === "" || short.toLowerCase() === data.toLowerCase()) return ctx.skip();
      expect(hostRunPaths(short).dataDirId).toBe(id);
    },
  );

  it("moves a socket path over 100 bytes to a short per-data-dir directory", () => {
    const base = trackDir(tempDir());
    const long = join(base, "x".repeat(120));
    const short = trackDir(tempDir("ch-"));
    const p = unix(hostRunPaths(long, { tmpDir: short, platform: "darwin" }));
    expect(p.socketDir).toBe(join(short, `cashu-${p.dataDirId.slice(0, 16)}`));
    expect(Buffer.byteLength(p.socketPath)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    const linux = hostRunPaths(long, { platform: "linux", xdgRuntimeDir: short });
    expect(linux.socketDir).toBe(join(short, "cashu", p.dataDirId.slice(0, 16)));
    const tooLong = hostRunPaths(long, { tmpDir: join(base, "y".repeat(120)), platform: "darwin" });
    expect(() => assertSocketPath(tooLong)).toThrow(HostPathError);
    expect(() => assertSocketPath(p)).not.toThrow();
  });

  it("names a named pipe per data dir and start on Windows: no fallback dir, no length limit", () => {
    const base = trackDir(tempDir());
    const long = join(base, "x".repeat(120));
    const posix = hostRunPaths(long, { tmpDir: base, platform: "darwin" });
    const p = hostRunPaths(long, { tmpDir: base, platform: "win32" });
    expect(p.transport).toBe("named-pipe");
    expect("socketPath" in p).toBe(false);
    expect(p.dataDirId).toBe(posix.dataDirId);
    expect(p.socketDir).toBe(p.runDir);
    // The run dir's files are where they are on macOS and Linux.
    for (const key of ["runDir", "lockPath", "tokenPath", "discoveryPath", "logPath"] as const) {
      expect(p[key]).toBe(posix[key]);
    }
    expect(() => assertSocketPath(p)).not.toThrow();
    const suffix = "0123456789abcdef";
    const pipe = hostPipeName(p.dataDirId, suffix);
    expect(pipe).toBe(`\\\\.\\pipe\\cashu-host-${p.dataDirId.slice(0, 32)}-${suffix}`);
    expect(() => hostPipeName(p.dataDirId, "short")).toThrow(HostPathError);
    expect(() => hostPipeName("not-an-id", suffix)).toThrow(HostPathError);
  });

  it("accepts only this data dir's local host pipes from host.json", () => {
    const id = "a".repeat(64);
    const other = "b".repeat(64);
    const pipe = hostPipeName(id, "0123456789abcdef");
    expect(isHostPipeName(pipe, id)).toBe(true);
    expect(isHostPipeName(pipe, other)).toBe(false);
    expect(isHostPipeName(hostPipeName(other, "0123456789abcdef"), id)).toBe(false);
    // A pipe on another machine would carry this user's credentials over the network.
    expect(isHostPipeName(pipe.replace("\\\\.\\", "\\\\server\\"), id)).toBe(false);
    expect(isHostPipeName(`${pipe}0`, id)).toBe(false);
    expect(isHostPipeName(`${pipe}\\x`, id)).toBe(false);
    expect(isHostPipeName(pipe.toUpperCase(), id)).toBe(false);
    expect(isHostPipeName(join("/tmp", "host.sock"), id)).toBe(false);
  });

  it.skipIf(ON_WINDOWS)("makes private dirs 0700", () => {
    const dir = join(trackDir(tempDir()), "a", "run");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  // A directory link: a junction on Windows (no privilege needed), a symlink elsewhere.
  it("refuses a directory link in place of a private dir", () => {
    const base = trackDir(tempDir());
    const dir = join(base, "a", "run");
    ensurePrivateDir(dir);
    linkDir(dir, join(base, "evil"));
    expect(() => ensurePrivateDir(join(base, "evil"))).toThrow(
      new HostPathError(`${join(base, "evil")} is not a directory`),
    );
  });

  it("checks only the type of a private dir on Windows, where modes are synthetic", () => {
    const base = trackDir(tempDir());
    const dir = join(base, "a", "run");
    ensurePrivateDir(dir, "win32");
    expect(statSync(dir).isDirectory()).toBe(true);
    writeFileSync(join(base, "file"), "synthetic");
    expect(() => ensurePrivateDir(join(base, "file"), "win32")).toThrow();
  });

  it.skipIf(ON_WINDOWS)("leaves a POSIX mode alone when told the platform is Windows", () => {
    const dir = join(trackDir(tempDir()), "run");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensurePrivateDir(dir, "win32");
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });
});
