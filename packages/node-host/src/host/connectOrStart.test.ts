// Real host processes (the fixture host, spawned detached like a client would), racing for one data
// dir, killed with SIGKILL, restarted.
// Synthetic temp dirs only.
import { readFileSync } from "node:fs";
import type { AdminStatus } from "@cashu/host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  isAlive,
  type SpawnedHost,
  spawnFixtureHost,
  tempDir,
  trackDir,
} from "../testing/hostHarness.js";
import { HostConnectError } from "./client.js";
import { connectOrStart, HostStartError } from "./connectOrStart.js";
import { readDiscovery } from "./files.js";
import { hostRunPaths } from "./paths.js";
import { HOST_BUSY_EXIT } from "./server.js";

afterEach(cleanup);

const SLOW = 60_000;

async function admin(dataDir: string, spawned: SpawnedHost[]) {
  const { connection, started } = await connectOrStart({
    dataDir,
    role: "admin",
    build: "test-client",
    deadlineMs: 20_000,
    start: () => {
      spawned.push(spawnFixtureHost(dataDir));
    },
  });
  const status = (await connection.call("admin.status")) as AdminStatus;
  return { connection, started, status };
}

describe("connect-or-start", () => {
  it(
    "8 clients on an empty data dir at once end with exactly one host",
    async () => {
      const dir = trackDir(tempDir());
      const spawned: SpawnedHost[] = [];
      const clients = await Promise.all(Array.from({ length: 8 }, () => admin(dir, spawned)));
      const pids = new Set(clients.map((c) => c.status.pid));
      expect(pids.size).toBe(1);
      const [winner] = [...pids] as [number];
      expect(readDiscovery(hostRunPaths(dir).discoveryPath)?.pid).toBe(winner);
      expect(spawned.length).toBeGreaterThanOrEqual(1);
      expect(spawned.length).toBeLessThanOrEqual(8);
      // Every other spawned host lost the lock and exited 3; the winner is the only one alive.
      const losers = spawned.filter((s) => s.child.pid !== winner);
      expect(losers).toHaveLength(spawned.length - 1);
      expect(await Promise.all(losers.map((s) => s.exit))).toEqual(
        losers.map(() => HOST_BUSY_EXIT),
      );
      expect(spawned.filter((s) => s.child.pid !== undefined && isAlive(s.child.pid))).toHaveLength(
        1,
      );
      expect(clients.at(-1)?.status.sessions.admin).toBe(8);
      const log = readFileSync(hostRunPaths(dir).logPath, "utf8");
      expect(log.match(/^ready /gm)).toHaveLength(1);
      for (const c of clients) c.connection.close();
      await clients[0]?.connection.call("admin.stop").catch(() => {});
    },
    SLOW,
  );

  it(
    "a SIGKILLed host's lock is released by the OS; the next client starts a new host",
    async () => {
      const dir = trackDir(tempDir());
      const spawned: SpawnedHost[] = [];
      const first = await admin(dir, spawned);
      expect(first.started).toBe(true);
      // A second host started by hand while one runs refuses (exit 3).
      const manual = spawnFixtureHost(dir);
      expect(await manual.exit).toBe(HOST_BUSY_EXIT);

      const closed = new Promise<void>((r) => first.connection.onClose(r));
      process.kill(first.status.pid, "SIGKILL");
      await closed;
      // Its socket file, token and host.json are left behind; the new host replaces them.
      const second = await admin(dir, spawned);
      expect(second.started).toBe(true);
      expect(second.status.pid).not.toBe(first.status.pid);
      expect(isAlive(first.status.pid)).toBe(false);
      expect(readDiscovery(hostRunPaths(dir).discoveryPath)?.pid).toBe(second.status.pid);
      // A running host is reached without starting another.
      const third = await admin(dir, spawned);
      expect(third.started).toBe(false);
      expect(third.status.pid).toBe(second.status.pid);
      await second.connection.call("admin.stop");
    },
    SLOW,
  );

  it(
    "gives up with a fixed error when no host comes up, and never retries a refusal",
    async () => {
      const dir = trackDir(tempDir());
      let t = 0;
      let starts = 0;
      const attempt = connectOrStart({
        dataDir: dir,
        role: "cli",
        build: "c",
        start: () => {
          starts += 1;
        },
        deadlineMs: 1_000,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      });
      const error = await attempt.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HostStartError);
      expect((error as HostStartError).exitCode).toBe(69);
      expect((error as HostStartError).last.kind).toBe("unavailable");
      expect(starts).toBe(1);

      const spawned: SpawnedHost[] = [];
      const running = await admin(dir, spawned);
      const refused = await connectOrStart({
        dataDir: dir,
        role: "cli",
        build: "c",
        protocol: { major: 2, minor: 0 },
        start: () => {
          starts += 1;
        },
      }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(HostConnectError);
      expect((refused as HostConnectError).reason).toBe("protocol");
      expect(starts).toBe(1);
      await running.connection.call("admin.stop");
    },
    SLOW,
  );
});
