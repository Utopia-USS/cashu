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
import { chooseLoopbackPort } from "./net.js";
import { parseDashboardLine, redactToken, stripAnsi } from "./security.js";

/**
 * Strangler v1: the dashboard is served by the Python `cashu serve` as a child process (today's
 * pywebview shell runs the same app in-process, desktop/shell.py `ServerThread`). The shell picks
 * the port, learns the per-launch API token from the one-time `Dashboard:` line on stdout, hands
 * it to the page only through the token bridge, and stops the child on quit.
 */

export class SidecarError extends Error {}

export interface SidecarSpec {
  command: string;
  /** Arguments before `--port <n>`. */
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
export type ProbeFn = (url: string) => Promise<boolean>;

export interface SidecarOptions {
  spec: SidecarSpec;
  dataDir: string;
  baseEnv: NodeJS.ProcessEnv;
  preferredPort?: number | null;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  spawn?: SpawnFn;
  choosePort?: (preferred?: number | null) => Promise<number>;
  probe?: ProbeFn;
  onLog?: (line: string) => void;
  /** The sidecar died after it had started (not because of `stop()`). */
  onExit?: (message: string) => void;
}

const MAX_ATTEMPTS = 3;
const BIND_FAILED = /address already in use|EADDRINUSE|Errno (?:48|98)\b/i;
const STARTED_MARKER = "Application startup complete";
/** uvicorn's request log (method, path, status): kept out of the log, paths carry profile slugs. */
export const ACCESS_LINE = /^INFO:\s+\S+:\d+ - "/;

/** The sidecar's environment: the data dir is explicit, nothing can inject a token or embed it. */
export function buildSidecarEnv(base: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env[ENV.dataDir] = dataDir;
  env.CASHU_HOST = "127.0.0.1";
  env.CASHU_DEV_EMBED_TOKEN = "";
  env.PYTHONUNBUFFERED = "1";
  env.COLUMNS = "400"; // rich must not wrap the one-time Dashboard line
  env.NO_COLOR = "1"; // ... nor colour it
  delete env.FORCE_COLOR;
  delete env.CASHU_API_TOKEN;
  delete env.CASHU_PORT;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
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

/** GET `url` over plain node:http (no proxy, no keep-alive): true on a 2xx answer. */
const defaultProbe: ProbeFn = (url) =>
  new Promise((resolve) => {
    const request = httpGet(url, { agent: false, timeout: 2000 }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export class Sidecar {
  private child: ChildProcess | null = null;
  private exited = false;
  private stopping: Promise<void> | null = null;
  private info: SidecarInfo | null = null;
  private readonly opts: Required<Omit<SidecarOptions, "preferredPort" | "onLog" | "onExit">> &
    Pick<SidecarOptions, "preferredPort" | "onLog" | "onExit">;

  constructor(opts: SidecarOptions) {
    this.opts = {
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      stopTimeoutMs: STOP_TIMEOUT_MS,
      spawn: nodeSpawn,
      choosePort: chooseLoopbackPort,
      probe: defaultProbe,
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
        this.info = await this.launch(port);
        return this.info;
      } catch (error) {
        lastError = error instanceof SidecarError ? error : new SidecarError(String(error));
        await this.stop();
        this.stopping = null;
        this.child = null;
        this.exited = false;
        if (!BIND_FAILED.test(lastError.message)) break;
        preferred = null; // the remembered port was taken in between: any free one
      }
    }
    throw lastError;
  }

  private launch(port: number): Promise<SidecarInfo> {
    const { spec, dataDir, baseEnv, spawn, probe, startupTimeoutMs, onLog } = this.opts;
    const child = spawn(spec.command, [...spec.args, "--port", String(port)], {
      cwd: spec.cwd,
      env: buildSidecarEnv(baseEnv, dataDir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.exited = false;
    const base = `http://127.0.0.1:${port}`;

    return new Promise<SidecarInfo>((resolveLaunch, rejectLaunch) => {
      let output = "";
      let tail = "";
      let settled = false;
      let dashboard: ReturnType<typeof parseDashboardLine> = null;
      let probing = false;

      const finish = (error: SidecarError | null, info?: SidecarInfo) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectLaunch(error);
        else if (info) resolveLaunch(info);
      };
      const fail = (message: string) =>
        finish(new SidecarError(`${message}${tail ? `: ${redactToken(tail).slice(-400)}` : ""}`));

      const tryReady = async () => {
        if (settled || probing || !dashboard || !output.includes(STARTED_MARKER)) return;
        if (dashboard.port !== port) {
          fail(`The sidecar announced port ${dashboard.port}, not ${port}`);
          return;
        }
        probing = true;
        for (let i = 0; i < 100 && !settled; i++) {
          if (await probe(`${base}/`)) {
            // Our own child announced the bind and is still alive: the answer is ours.
            if (this.exited) break;
            finish(null, {
              port,
              token: dashboard.token,
              origin: base,
              url: `${base}/`,
              pid: child.pid,
            });
            return;
          }
          await sleep(100);
        }
        probing = false;
      };

      const feed = (chunk: Buffer | string) => {
        const text = stripAnsi(chunk.toString());
        output += text;
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          if (ACCESS_LINE.test(line.trim())) continue;
          tail = line.trim();
          onLog?.(redactToken(line));
        }
        dashboard ??= parseDashboardLine(output);
        void tryReady();
      };
      child.stdout?.on("data", feed);
      child.stderr?.on("data", feed);
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
    });
  }

  /** SIGINT (uvicorn drains and removes its token file), SIGKILL after the timeout. Idempotent. */
  stop(): Promise<void> {
    this.stopping ??= this.terminate();
    return this.stopping;
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child || this.exited || child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise<void>((done) => child.once("exit", () => done()));
    child.kill("SIGINT");
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
