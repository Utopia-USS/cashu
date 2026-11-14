import { mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir, trackDir } from "../testing/hostHarness.js";
import {
  assertSocketPath,
  ensurePrivateDir,
  HostPathError,
  hostRunPaths,
  MAX_SOCKET_PATH_BYTES,
} from "./paths.js";

afterEach(cleanup);

describe("host run paths", () => {
  it("puts everything under <data dir>/run, named by the data dir's real path", () => {
    const base = trackDir(tempDir());
    const data = join(base, "data");
    mkdirSync(data);
    symlinkSync(data, join(base, "link"));
    const p = hostRunPaths(data);
    expect(p.runDir).toBe(join(data, "run"));
    expect(p.socketPath).toBe(join(data, "run", "host.sock"));
    expect(p.socketDir).toBe(p.runDir);
    expect(p.lockPath).toBe(join(data, "run", "host.lock.db"));
    expect(p.logPath).toBe(join(data, "logs", "host.log"));
    expect(p.dataDirId).toMatch(/^[0-9a-f]{64}$/);
    // The same data dir through a symlink is the same host; another data dir is another host.
    expect(hostRunPaths(join(base, "link")).dataDirId).toBe(p.dataDirId);
    expect(hostRunPaths(join(base, "other")).dataDirId).not.toBe(p.dataDirId);
  });

  it("moves a socket path over 100 bytes to a short per-data-dir directory", () => {
    const base = trackDir(tempDir());
    const long = join(base, "x".repeat(120));
    const short = trackDir(tempDir("ch-"));
    const p = hostRunPaths(long, { tmpDir: short, platform: "darwin" });
    expect(p.socketDir).toBe(join(short, `cashu-${p.dataDirId.slice(0, 16)}`));
    expect(Buffer.byteLength(p.socketPath)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    const linux = hostRunPaths(long, { platform: "linux", xdgRuntimeDir: short });
    expect(linux.socketDir).toBe(join(short, "cashu", p.dataDirId.slice(0, 16)));
    const tooLong = hostRunPaths(long, { tmpDir: join(base, "y".repeat(120)) });
    expect(() => assertSocketPath(tooLong)).toThrow(HostPathError);
    expect(() => assertSocketPath(p)).not.toThrow();
    expect(() => hostRunPaths(base, { platform: "win32" })).toThrow(/Windows/);
  });

  it("makes private dirs 0700 and refuses a symlink in their place", () => {
    const base = trackDir(tempDir());
    const dir = join(base, "a", "run");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    symlinkSync(dir, join(base, "evil"));
    expect(() => ensurePrivateDir(join(base, "evil"))).toThrow(HostPathError);
  });
});
