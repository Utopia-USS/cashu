// The host's CLI runner over a real host socket (in-process host, temp data dir): the routing reply
// (delegate with the Python CLI, exit for a ported command), output notes in order, prompts answered by
// the client (hidden flag passed on), stdin on demand, Ctrl-C (cancel -> 130), one exec per session,
// a build without Python, and refusals of malformed requests.
import { CLI_INTERRUPTED_EXIT, type CliExecParams, type HostFrame } from "@cashu/host-protocol";
import { connectHost, type HostConnection } from "@cashu/node-host";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import type { PortedCommand } from "./tree.js";

afterEach(cleanup);

const PYTHON = { command: "/opt/fake/bin/cashu", args: ["--from-test"] };

const params = (argv: string[], env: Record<string, string> = {}): CliExecParams => ({
  argv,
  cwd: "/tmp",
  env,
  tty: { stdin: false, stdout: false, stderr: false },
});

/** Test-only ported commands exercising every CommandIo channel. */
const TEST_COMMANDS: PortedCommand[] = [
  {
    name: "say",
    async run(args, io, root) {
      io.stdout(`args ${JSON.stringify(args)} profile ${root.profile ?? "-"}\n`);
      io.stderr("to stderr\n");
      return 3;
    },
  },
  {
    name: "ask",
    async run(_args, io) {
      const name = await io.prompt("Name: ");
      const secret = await io.prompt("Secret: ", { hidden: true });
      io.stdout(`${name}/${secret === null ? "null" : secret.length}\n`);
      return 0;
    },
  },
  {
    name: "cat",
    async run(_args, io) {
      const parts: string[] = [];
      for await (const chunk of io.stdin()) parts.push(Buffer.from(chunk).toString("utf8"));
      io.stdout(parts.join(""));
      return 0;
    },
  },
  {
    name: "wait",
    async run(_args, io) {
      await new Promise<void>((resolve) => io.signal.addEventListener("abort", () => resolve()));
      return 0;
    },
  },
];

async function host(python: typeof PYTHON | null = PYTHON) {
  const dir = tempDir();
  const h = await startLocalHost({
    ...testHostOptions(dir),
    python,
    ported: TEST_COMMANDS,
    launcher: false,
  });
  const conn = await connectHost({ dataDir: dir, role: "cli", build: "test" });
  return { dir, h, conn };
}

interface Exec {
  readonly notes: { method: string; params: unknown }[];
  readonly result: Promise<unknown>;
}

/** Sends one exec (id 1) and collects its notes; `answer` reacts to each note. */
function exec(
  conn: HostConnection,
  p: CliExecParams,
  answer: (method: string, params: Record<string, unknown>) => void = () => {},
): Exec {
  const notes: { method: string; params: unknown }[] = [];
  const result = new Promise<unknown>((resolve, reject) => {
    conn.onFrame((frame: HostFrame) => {
      if (frame.t === "note" && frame.id === 1) {
        notes.push({ method: frame.method, params: frame.params });
        answer(frame.method, frame.params as Record<string, unknown>);
      } else if (frame.t === "res" && frame.id === 1) {
        if (frame.outcome.ok) resolve(frame.outcome.result);
        else reject(new Error(frame.outcome.error.code));
      }
    });
  });
  conn.send({ t: "req", id: 1, method: "cli.exec", params: p as never });
  return { notes, result };
}

describe("cli.exec", () => {
  it("delegates a Python command with the Python CLI, without output", async () => {
    const { h, conn } = await host();
    const e = exec(conn, params(["--profile", "demo-anna", "stats", "--months", "3"]));
    expect(await e.result).toEqual({
      kind: "delegate",
      command: PYTHON.command,
      args: PYTHON.args,
    });
    expect(e.notes).toEqual([]);
    conn.close();
    await h.stop();
  });

  it("delegates the root help, unknown commands and root parse errors (Python prints them)", async () => {
    const { h, conn } = await host();
    for (const argv of [[], ["--help"], ["nonexistent"], ["--profile"]]) {
      const c = await connectHost({ dataDir: h.server.paths.dataDir, role: "cli", build: "test" });
      expect(await exec(c, params(argv)).result).toMatchObject({ kind: "delegate" });
      c.close();
    }
    conn.close();
    await h.stop();
  });

  it("runs a ported command: raw args after its name, root profile, output in order, exit code", async () => {
    const { h, conn } = await host();
    const e = exec(conn, params(["-p", "demo-anna", "say", "--x", "1", "--", "y"]));
    expect(await e.result).toEqual({ kind: "exit", code: 3 });
    expect(e.notes).toEqual([
      {
        method: "cli.out",
        params: { stream: "stdout", data: 'args ["--x","1","--","y"] profile demo-anna\n' },
      },
      { method: "cli.out", params: { stream: "stderr", data: "to stderr\n" } },
    ]);
    conn.close();
    await h.stop();
  });

  it("asks the client's terminal, hidden when the command says so", async () => {
    const { h, conn } = await host();
    const answers: Record<string, string | null> = { "Name: ": "Ala", "Secret: ": null };
    let answered = 10;
    const e = exec(conn, params(["ask"]), (method, p) => {
      if (method !== "cli.prompt") return;
      answered += 1;
      conn.send({
        t: "req",
        id: answered,
        method: "cli.answer",
        params: { exec: 1, pid: p.pid as number, value: answers[p.text as string] ?? null },
      });
    });
    expect(await e.result).toEqual({ kind: "exit", code: 0 });
    const prompts = e.notes.filter((n) => n.method === "cli.prompt").map((n) => n.params);
    expect(prompts).toEqual([
      { pid: 1, text: "Name: ", hidden: false },
      { pid: 2, text: "Secret: ", hidden: true },
    ]);
    expect(e.notes.at(-1)?.params).toEqual({ stream: "stdout", data: "Ala/null\n" });
    conn.close();
    await h.stop();
  });

  it("reads stdin only when the command asks for it", async () => {
    const { h, conn } = await host();
    const e = exec(conn, params(["cat"]), (method) => {
      if (method !== "cli.stdin") return;
      const chunk = (id: number, text: string, eof: boolean) =>
        conn.send({
          t: "req",
          id,
          method: "cli.stdin",
          params: { exec: 1, data: Buffer.from(text).toString("base64"), eof },
        });
      chunk(20, "zażółć ", false);
      chunk(21, "gęślą", true);
    });
    expect(await e.result).toEqual({ kind: "exit", code: 0 });
    expect(e.notes.map((n) => n.method)).toEqual(["cli.stdin", "cli.out"]);
    expect(e.notes[1]?.params).toEqual({ stream: "stdout", data: "zażółć gęślą" });
    conn.close();
    await h.stop();
  });

  it("cancels on Ctrl-C with exit 130", async () => {
    const { h, conn } = await host();
    const e = exec(conn, params(["wait"]));
    await new Promise((r) => setTimeout(r, 20));
    conn.send({ t: "cancel", id: 1 });
    expect(await e.result).toEqual({ kind: "exit", code: CLI_INTERRUPTED_EXIT });
    conn.close();
    await h.stop();
  });

  it("refuses a second exec while one runs and a malformed exec", async () => {
    const { h, conn } = await host();
    const first = exec(conn, params(["wait"]));
    const second = conn.call("cli.exec", params(["say"]));
    await expect(second).rejects.toMatchObject({ code: "busy" });
    await expect(conn.call("cli.exec", { argv: "say" })).rejects.toMatchObject({
      code: "invalid-params",
    });
    await expect(conn.call("cli.answer", { exec: 1, pid: 99, value: "x" })).rejects.toMatchObject({
      code: "invalid-params",
    });
    await expect(conn.call("cli.nothing", {})).rejects.toMatchObject({ code: "unknown-method" });
    conn.send({ t: "cancel", id: 1 });
    expect(await first.result).toEqual({ kind: "exit", code: CLI_INTERRUPTED_EXIT });
    conn.close();
    await h.stop();
  });

  it("reports unsupported native commands in the command's language", async () => {
    const { h, conn } = await host(null);
    const e = exec(conn, params(["stats"], { CASHU_LANG: "pl" }));
    expect(await e.result).toEqual({ kind: "exit", code: 2 });
    expect(e.notes).toHaveLength(1);
    expect(e.notes[0]?.params).toMatchObject({
      data: expect.stringMatching(/^Nieznane lub nieobsługiwane/),
    });
    conn.close();
    await h.stop();
  });

  it("aborts a running command when the client goes away", async () => {
    let fixture: Awaited<ReturnType<typeof host>> | undefined;
    let aborted = false;
    let started!: () => void;
    let stopped!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const watcher: PortedCommand = {
      name: "watch",
      async run(_args, io) {
        await new Promise<void>((resolve) => {
          io.signal.addEventListener("abort", () => resolve(), { once: true });
          started();
        });
        aborted = true;
        stopped();
        return 0;
      },
    };
    TEST_COMMANDS.push(watcher);
    try {
      fixture = await host();
      const { conn } = fixture;
      exec(conn, params(["watch"]));
      await ready;
      conn.close();
      await finished;
      expect(aborted).toBe(true);
    } finally {
      TEST_COMMANDS.pop();
      await fixture?.h.stop();
    }
  });
});
