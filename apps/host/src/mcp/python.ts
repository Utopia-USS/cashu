// TRANSITIONAL(S38f): the MCP server of a session is, until the S38 slices port it, the Python one: a
// `cashu mcp --profile <slug>` child per session, speaking MCP over its stdio exactly as when Claude
// Code started it directly (same tool list, schemas, privacy layer, audit rows). The host relays lines
// and passes the child's stderr on. Its environment is the host's, the session's forwarded variables
// (an `.mcp.json` entry's CASHU_* settings) and `CASHU_DATA_DIR` = the host's data dir, so a host can
// never serve another data dir's database; its working directory is the shim's (relative file paths
// in tool arguments). Closing the session ends the child's stdin, then SIGTERM, then SIGKILL.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { McpOpenParams } from "@cashu/host-protocol";
import type { Program } from "../runtime.js";
import type { McpBackend } from "./session.js";

const TERM_AFTER_MS = 3_000;
const KILL_AFTER_MS = 2_000;

export interface PythonMcpOptions {
  readonly program: Program;
  readonly dataDir: string;
  readonly profile: string;
  readonly open: McpOpenParams;
  /** The host's own environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

function pythonMcpEnv(options: PythonMcpOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...options.env, ...options.open.env };
  env.CASHU_DATA_DIR = options.dataDir;
  delete env.FINANSE_DATA_DIR;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function startPythonMcp(options: PythonMcpOptions): McpBackend {
  const child: ChildProcessWithoutNullStreams = spawn(
    options.program.command,
    [...options.program.args, "mcp", "--profile", options.profile],
    {
      cwd: existsSync(options.open.cwd) ? options.open.cwd : options.dataDir,
      env: pythonMcpEnv(options),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let lineHandler: (line: string) => void = () => {};
  let stderrHandler: (data: string) => void = () => {};
  let exitHandler: (code: number) => void = () => {};
  let exitCode: number | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      exitCode = code ?? (signal === null ? 1 : 128 + signalNumber(signal));
      resolve();
      exitHandler(exitCode);
    });
  });
  child.once("error", () => {
    // spawn failed (no such executable): reported like a server that exited at once.
    if (exitCode === undefined) {
      exitCode = 1;
      exitHandler(1);
    }
  });
  const out = new StringDecoder("utf8");
  let partial = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const lines = (partial + out.write(chunk)).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) lineHandler(line);
  });
  const err = new StringDecoder("utf8");
  child.stderr.on("data", (chunk: Buffer) => {
    const text = err.write(chunk);
    if (text !== "") stderrHandler(text);
  });
  // A write after the child went away is not an error of the host.
  child.stdin.on("error", () => {});

  return {
    send(line) {
      if (exitCode === undefined && child.stdin.writable) child.stdin.write(`${line}\n`);
    },
    onLine: (handler) => {
      lineHandler = handler;
    },
    onStderr: (handler) => {
      stderrHandler = handler;
    },
    onExit: (handler) => {
      exitHandler = handler;
      if (exitCode !== undefined) handler(exitCode);
    },
    async close() {
      if (exitCode !== undefined) return;
      child.stdin.end();
      const term = setTimeout(() => child.kill("SIGTERM"), TERM_AFTER_MS);
      const kill = setTimeout(() => child.kill("SIGKILL"), TERM_AFTER_MS + KILL_AFTER_MS);
      await exited;
      clearTimeout(term);
      clearTimeout(kill);
    },
  };
}

function signalNumber(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return numbers[signal] ?? 0;
}
