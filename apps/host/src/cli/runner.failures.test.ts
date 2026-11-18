// The CLI runner's failure paths over an in-memory session: a command waits for running vault sync
// passes and then starts, a read of a vault that is not current becomes a typed "try again" refusal
// (exit 75), and an unexpected error is logged and shown with its short code and the command name,
// never its message.
import { tmpdir } from "node:os";
import type { CliExecParams, ClientFrame, HostFrame } from "@cashu/host-protocol";
import type { HostSession } from "@cashu/node-host";
import { describe, expect, it } from "vitest";
import { memoryLog } from "../log.js";
import { NativeSessionUnavailableError } from "../stores.js";
import { serveCliSession } from "./runner.js";
import type { SyncingSession } from "./syncGate.js";
import type { PortedCommand } from "./tree.js";

const params = (argv: string[]): CliExecParams => ({
  argv,
  cwd: tmpdir(),
  paths: { home: tmpdir() },
  env: { CASHU_LANG: "en" },
  tty: { stdin: false, stdout: false, stderr: false },
});

/** A session whose frames stay in memory; `exec` sends one cli.exec and resolves with its reply. */
function fakeSession() {
  const sent: HostFrame[] = [];
  let handler: (frame: ClientFrame) => void = () => {};
  let replied: (frame: HostFrame) => void = () => {};
  const session: HostSession = {
    id: 1,
    role: "cli",
    profile: undefined,
    build: "test",
    protocol: { major: 1, minor: 0 } as HostSession["protocol"],
    send(frame) {
      sent.push(frame);
      if (frame.t === "res") replied(frame);
    },
    onFrame(h) {
      handler = h;
    },
    onClose() {},
    close() {},
  };
  const exec = (argv: string[]) =>
    new Promise<HostFrame>((resolve) => {
      replied = resolve;
      handler({ t: "req", id: 7, method: "cli.exec", params: params(argv) as never });
    });
  const stderr = () =>
    sent
      .flatMap((frame) =>
        frame.t === "note" &&
        frame.method === "cli.out" &&
        (frame.params as { stream: string }).stream === "stderr"
          ? [(frame.params as { data: string }).data]
          : [],
      )
      .join("");
  return { session, exec, stderr };
}

/** A native session stand-in whose pass the test settles. */
function syncingSession(): SyncingSession & { settle(): void } {
  const listeners = new Set<() => void>();
  let syncing = true;
  return {
    isSyncing: () => syncing,
    onSyncSettled(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle() {
      syncing = false;
      for (const listener of [...listeners]) listener();
    },
  };
}

const command = (name: string, run: PortedCommand["run"]): PortedCommand => ({ name, run });

describe("cli.exec failures", () => {
  it("starts a command only after the running sync pass settled", async () => {
    const pass = syncingSession();
    const started: boolean[] = [];
    const { session, exec } = fakeSession();
    serveCliSession(session, {
      dataDir: tmpdir(),
      log: memoryLog(),
      syncing: () => [pass],
      ported: [
        command("read", async () => {
          // What a vault read checks: the pass must be over when the command begins.
          started.push(pass.isSyncing());
          return 0;
        }),
      ],
    });
    const reply = exec(["read"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([]);
    pass.settle();
    expect(await reply).toMatchObject({ outcome: { ok: true, result: { kind: "exit", code: 0 } } });
    expect(started).toEqual([false]);
  });

  it("starts anyway once the wait budget ran out, and refuses the unreadable vault with exit 75", async () => {
    const pass = syncingSession();
    const log = memoryLog();
    const { session, exec, stderr } = fakeSession();
    serveCliSession(session, {
      dataDir: tmpdir(),
      log,
      syncing: () => [pass],
      syncWaitMs: 10,
      ported: [
        command("stats", async () => {
          if (pass.isSyncing()) throw new NativeSessionUnavailableError();
          return 0;
        }),
      ],
    });
    expect(await exec(["--profile", "smoke", "stats"])).toMatchObject({
      outcome: { ok: true, result: { kind: "exit", code: 75 } },
    });
    expect(stderr()).toContain("a profile is not available right now");
    expect(stderr()).not.toContain("unexpected");
    expect(log.lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        level: "warn",
        event: "cli.exec-refused",
        error: "NativeSessionUnavailableError",
        code: "native_session_unavailable",
        command: "stats",
      }),
    ]);
  });

  it("logs an unexpected error's class, short code and SQLite result code, never its message", async () => {
    const log = memoryLog();
    const { session, exec, stderr } = fakeSession();
    serveCliSession(session, {
      dataDir: tmpdir(),
      log,
      ported: [
        command("stats", async () => {
          // node:sqlite's shape: a plain Error, the generic code, the numeric result code.
          throw Object.assign(new Error("database is locked: Synthetic Value"), {
            code: "ERR_SQLITE_ERROR",
            errcode: 5,
          });
        }),
      ],
    });
    expect(await exec(["-p", "stats-like-slug", "stats"])).toMatchObject({
      outcome: { ok: true, result: { kind: "exit", code: 70 } },
    });
    expect(stderr()).toBe("cashu: unexpected Error (ERR_SQLITE_ERROR)\n");
    const [line] = log.lines;
    expect(line).not.toContain("Synthetic");
    expect(JSON.parse(line as string)).toMatchObject({
      level: "error",
      event: "cli.exec-failed",
      error: "Error",
      code: "ERR_SQLITE_ERROR",
      sqlite: 5,
      command: "stats",
    });
  });

  it("logs an error without a short code as unknown", async () => {
    const log = memoryLog();
    const { session, exec, stderr } = fakeSession();
    serveCliSession(session, {
      dataDir: tmpdir(),
      log,
      ported: [
        command("boom", async () => {
          throw new TypeError("Synthetic message with a value 123");
        }),
      ],
    });
    expect(await exec(["boom"])).toMatchObject({
      outcome: { ok: true, result: { kind: "exit", code: 70 } },
    });
    expect(stderr()).toBe("cashu: unexpected TypeError\n");
    expect(JSON.parse(log.lines[0] as string)).toMatchObject({
      error: "TypeError",
      code: "?",
      sqlite: null,
      command: "boom",
    });
  });
});
