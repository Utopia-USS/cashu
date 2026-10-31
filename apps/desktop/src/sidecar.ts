/// <reference types="node" />
import {
  type ChildProcess,
  spawn as nodeSpawn,
  type SpawnOptions,
  spawnSync,
} from "node:child_process";
import { get as httpGet } from "node:http";
import { dirname, join } from "node:path";
import { ENV, realResolve, STARTUP_TIMEOUT_MS, STOP_TIMEOUT_MS } from "./config.js";
import { chooseLoopbackPort, isPortFree } from "./net.js";
import { generateToken, redactToken, stripAnsi } from "./security.js";

/**
 * Strangler v1: the dashboard is served by the Python `cashu serve` as a child process (today's
 * pywebview shell runs the same app in-process, desktop/shell.py `ServerThread`). The contract is
 * explicit, nothing is read from the child's output:
 *  - the shell picks the port and generates the per-launch API token, and starts
 *    `cashu serve --parent-pipe --port <n>`; the token is the first line on the child's stdin
 *    (core/parent_pipe.py), so it is never on a command line, in the environment, printed or stored;
 *  - the shell keeps stdin open: when the shell exits or is killed, the pipe closes and the child
 *    stops itself (no orphan); `stop()` closes it on purpose, with SIGKILL as the last resort;
 *  - ready = `GET /api/health` with the token answers 200 while our own child is alive (a server
 *    that does not hold our token answers 401, so a foreign process on the port is never taken
 *    for ours);
 *  - the child's output only goes to the log (request lines dropped, token redacted).
 */

export class SidecarError extends Error {}

export interface SidecarSpec {
  command: string;
  /** Arguments before `--parent-pipe --port <n>`. */
  args: string[];
  cwd: string;
}

export interface SidecarInfo {
  port: number;
  token: string;
  origin: string;
  url: string;
  pid: number | undefined;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
/** One readiness probe: the HTTP status of `GET <url>` with the token header, null when unreachable. */
export type ProbeFn = (url: string, token: string) => Promise<number | null>;

export interface SidecarOptions {
  spec: SidecarSpec;
  dataDir: string;
  baseEnv: NodeJS.ProcessEnv;
  preferredPort?: number | null;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Pause between two readiness probes. */
  probeIntervalMs?: number;
  spawn?: SpawnFn;
  choosePort?: (preferred?: number | null) => Promise<number>;
  portFree?: (port: number) => Promise<boolean>;
  probe?: ProbeFn;
  newToken?: () => string;
  onLog?: (line: string) => void;
  /** The sidecar died after it had started (not because of `stop()`). */
  onExit?: (message: string) => void;
}

const MAX_ATTEMPTS = 3;
/** core/api.py `health`: token-protected, answered once the app has started. */
export const HEALTH_PATH = "/api/health";
export const TOKEN_HEADER = "X-Cashu-Token";
/** uvicorn's request log (method, path, status): kept out of the log, paths carry profile slugs. */
export const ACCESS_LINE = /^INFO:\s+\S+:\d+ - "/;

/** The sidecar's environment: the data dir is explicit, nothing can inject a token or embed it. */
export function buildSidecarEnv(base: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env[ENV.dataDir] = dataDir;
  env.CASHU_HOST = "127.0.0.1";
  env.CASHU_DEV_EMBED_TOKEN = "";
  env.PYTHONUNBUFFERED = "1";
  env.NO_COLOR = "1"; // plain log lines
  delete env.FORCE_COLOR;
  delete env.CASHU_API_TOKEN;
  delete env.CASHU_PORT;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** The sidecar's command line: the spec's arguments, then the parent-pipe contract and the port. */
export function sidecarArgs(spec: SidecarSpec, port: number): string[] {
  return [...spec.args, "--parent-pipe", "--port", String(port)];
}

/** Where the dev sidecar lives: `<repo>/.venv/bin/cashu`, or the CASHU_DESKTOP_SIDECAR_* override. */
export function sidecarSpec(root: string, env: NodeJS.ProcessEnv): SidecarSpec {
  const bin = env[ENV.sidecarBin]?.trim() || join(root, ".venv", "bin", "cashu");
  let args = ["serve"];
  const raw = env[ENV.sidecarArgs]?.trim();
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === "string")) {
      throw new SidecarError(`${ENV.sidecarArgs} must be a JSON array of strings`);
    }
    args = parsed as string[];
  }
  return { command: bin, args, cwd: root };
}

/**
 * Asks the sidecar's own Python which data dir it resolves, so that a stray `.env.dev` (or any
 * other fallback) can never point a launch at data the shell did not choose. Returns an error
 * message, or null when it matches (or the interpreter cannot be located).
 */
export function verifyDataDir(
  spec: SidecarSpec,
  expected: string,
  baseEnv: NodeJS.ProcessEnv,
  run: typeof spawnSync = spawnSync,
): string | null {
  const python = /(?:^|[\\/])python[0-9.]*$/.test(spec.command)
    ? spec.command
    : join(dirname(spec.command), "python");
  const result = run(python, ["-c", "from cashu.core import paths; print(paths.data_dir())"], {
    cwd: spec.cwd,
    env: buildSidecarEnv(baseEnv, expected),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    return `Could not ask the sidecar for its data dir (${python}): ${String(result.stderr).trim().slice(-200)}`;
  }
  const actual = String(result.stdout).trim().split("\n").pop()?.trim() ?? "";
  return realResolve(actual) === realResolve(expected)
    ? null
    : `The sidecar resolves its data dir to ${actual}, not ${expected}: refusing to start.`;
}

/** GET `url` with the token over plain node:http (no proxy, no keep-alive): the status code. */
export const defaultProbe: ProbeFn = (url, token) =>
  new Promise((resolve) => {
    const request = httpGet(
      url,
      { agent: false, timeout: 2000, headers: { [TOKEN_HEADER]: token } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? null);
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(null));
  });

/**
 * Splits a stream into whole lines. A pipe chunk is not a line: one write can arrive in two
 * chunks (Python's unbuffered `print` writes the text and the newline separately) and two writes in
 * one, so the trailing partial line waits for the next chunk. Only a whole line is filtered
 * (request log) and redacted (token), never a fragment of one.
 */
export class LineBuffer {
  private partial = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.onLine(line);
  }

  /** The stream ended: a last line without a newline is still a line. */
  flush(): void {
    const rest = this.partial;
    this.partial = "";
    if (rest) this.onLine(rest);
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type Resolved = Required<Omit<SidecarOptions, "preferredPort" | "onLog" | "onExit">> &
  Pick<SidecarOptions, "preferredPort" | "onLog" | "onExit">;

export class Sidecar {
  private child: ChildProcess | null = null;
  private exited = false;
  private stopping: Promise<void> | null = null;
  private info: SidecarInfo | null = null;
  private readonly opts: Resolved;

  constructor(opts: SidecarOptions) {
    this.opts = {
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      stopTimeoutMs: STOP_TIMEOUT_MS,
      probeIntervalMs: 100,
      spawn: nodeSpawn,
      choosePort: chooseLoopbackPort,
      portFree: isPortFree,
      probe: defaultProbe,
      newToken: () => generateToken(),
      ...opts,
    };
  }

  get started(): SidecarInfo | null {
    return this.info;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  async start(): Promise<SidecarInfo> {
    let preferred = this.opts.preferredPort ?? null;
    let lastError = new SidecarError("The local server did not start");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const port = await this.opts.choosePort(preferred);
      try {
        this.info = await this.launch(port, this.opts.newToken());
        return this.info;
      } catch (error) {
        lastError = error instanceof SidecarError ? error : new SidecarError(String(error));
        await this.stop();
        this.stopping = null;
        this.child = null;
        this.exited = false;
        // Our child is gone. If the port is taken now, another process bound it between the
        // choice and the child's bind: try any other free port. Anything else is a real failure.
        if (await this.opts.portFree(port)) break;
        preferred = null;
      }
    }
    throw lastError;
  }

  private launch(port: number, token: string): Promise<SidecarInfo> {
    const { spec, dataDir, baseEnv, spawn, probe, startupTimeoutMs, probeIntervalMs, onLog } =
      this.opts;
    const child = spawn(spec.command, sidecarArgs(spec, port), {
      cwd: spec.cwd,
      env: buildSidecarEnv(baseEnv, dataDir),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.exited = false;
    // The token, then the pipe stays open for the child's lifetime (its parent-death signal).
    child.stdin?.on("error", () => {}); // EPIPE when the child is already gone: the exit handler reports it
    child.stdin?.write(`${token}\n`);
    const base = `http://127.0.0.1:${port}`;

    return new Promise<SidecarInfo>((resolveLaunch, rejectLaunch) => {
      let tail = "";
      let settled = false;

      const finish = (error: SidecarError | null, info?: SidecarInfo) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectLaunch(error);
        else if (info) resolveLaunch(info);
      };
      const fail = (message: string) =>
        finish(
          new SidecarError(`${message}${tail ? `: ${redactToken(tail, token).slice(-400)}` : ""}`),
        );

      const logLine = (raw: string) => {
        const line = stripAnsi(raw).trim();
        if (!line || ACCESS_LINE.test(line)) return;
        tail = line;
        onLog?.(redactToken(line, token));
      };
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        // utf8 decoding keeps a multi-byte character split across chunks whole.
        stream.setEncoding("utf8");
        const lines = new LineBuffer(logLine);
        stream.on("data", (chunk: string) => lines.push(chunk));
        stream.once("end", () => lines.flush());
      }
      child.once("error", (error) => {
        if (this.child === child) this.exited = true;
        fail(`The local server could not be started (${error.message})`);
      });
      child.once("exit", (code, signal) => {
        if (this.child === child) this.exited = true;
        const how = signal ?? `exit ${code}`;
        if (settled) {
          if (!this.stopping && this.child === child) {
            this.opts.onExit?.(`The local server stopped unexpectedly (${how})`);
          }
          return;
        }
        fail(`The local server stopped during startup (${how})`);
      });
      const timer = setTimeout(
        () =>
          fail(`The local server did not start within ${Math.round(startupTimeoutMs / 1000)} s`),
        startupTimeoutMs,
      );

      // Readiness: the health probe, until it answers 200 or the launch settles otherwise.
      void (async () => {
        while (!settled) {
          const status = await probe(`${base}${HEALTH_PATH}`, token);
          if (settled) return;
          // 200 with our token while our own child is alive: the answer is ours.
          if (status === 200 && !this.exited) {
            finish(null, { port, token, origin: base, url: `${base}/`, pid: child.pid });
            return;
          }
          await sleep(probeIntervalMs);
        }
      })();
    });
  }

  /**
   * Closes the child's stdin (core/parent_pipe.py: the server drains and exits, the same path as a
   * dead shell), SIGKILL after the timeout. Idempotent.
   */
  stop(): Promise<void> {
    this.stopping ??= this.terminate();
    return this.stopping;
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child || this.exited || child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise<void>((done) => child.once("exit", () => done()));
    child.stdin?.end();
    const timedOut = await Promise.race([
      gone.then(() => false),
      sleep(this.opts.stopTimeoutMs).then(() => true),
    ]);
    if (timedOut) {
      child.kill("SIGKILL");
      await Promise.race([gone, sleep(2000)]);
    }
  }
}
