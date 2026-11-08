// The `cashu` shim: resolve the data dir (`.env.dev` included), then route the argv
// (route.ts) to the host's admin methods, an MCP session or `cli.exec`. Exit codes of its own: 64 usage
// (`cashu host ...`), 69 no host could be reached or started (never a fallback that would open a store
// in this process), 70 the host broke off or broke the protocol. Everything else is the command's code.
import { homedir, userInfo } from "node:os";
import { adminStatusResultSchema } from "@cashu/host-protocol";
import { createBackendI18n, createTranslator, type Translator } from "@cashu/i18n";
import {
  HOST_UNAVAILABLE_EXIT,
  HostConnectError,
  type HostConnection,
  HostStartError,
  nodeLanguageSource,
} from "@cashu/node-host";
import { forwardedEnv, HostLostError, ProtocolError, runExec } from "./cliClient.js";
import { type ResolvedDataDir, resolveDataDir } from "./dataDir.js";
import { desktopLaunch, runDesktopApp } from "./desktop.js";
import { checkoutRoot } from "./devenv.js";
import { foregroundEnv, runForeground } from "./foreground.js";
import {
  existingHost,
  type HostTarget,
  hostCommand,
  hostLogPath,
  reachHost,
  type ShimBuild,
} from "./host.js";
import { McpRelay } from "./mcpRelay.js";
import { route } from "./route.js";
import { bilingual, S } from "./strings.js";
import { processTerminal, type Terminal } from "./terminal.js";

const USAGE_EXIT = 64;
const NOT_RUNNING_EXIT = 3;
const FAILURE_EXIT = 70;

/** How the shim ends: an exit code, or the signal its foreground host died of (re-raised). */
export type MainOutcome = { readonly code: number } | { readonly signal: NodeJS.Signals };

export interface ShimProcess {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly build: ShimBuild;
  readonly terminal: Terminal;
  /** Installs a Ctrl-C handler; returns its removal. */
  onInterrupt(handler: () => void): () => void;
  /** Ends the process after stdout is flushed (MCP relay). */
  exit(code: number): void;
}

const passwdHome = () => {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
};

interface Context {
  readonly proc: ShimProcess;
  readonly dataDir: ResolvedDataDir;
  readonly t: Translator;
  readonly target: HostTarget;
  /** The caller environment after loading `.env.dev`. */
  readonly env: NodeJS.ProcessEnv;
}

const say = (proc: ShimProcess, stream: "stdout" | "stderr", text: string) =>
  proc.terminal.write(stream, `${text}\n`);

/** Exit 69 / 70 with the fixed text for a failure to reach the host. */
function unreachable(ctx: Context, error: unknown): MainOutcome {
  if (error instanceof HostStartError) {
    say(ctx.proc, "stderr", ctx.t.tr(S.hostUnavailable)(hostLogPath(ctx.dataDir.path)));
    return { code: HOST_UNAVAILABLE_EXIT };
  }
  if (error instanceof HostConnectError) {
    say(ctx.proc, "stderr", ctx.t.tr(error.reason === "protocol" ? S.hostOutdated : S.hostRefused));
    return { code: HOST_UNAVAILABLE_EXIT };
  }
  if (error instanceof HostLostError) {
    say(ctx.proc, "stderr", ctx.t.tr(S.hostLost));
    return { code: FAILURE_EXIT };
  }
  if (error instanceof ProtocolError) {
    say(ctx.proc, "stderr", ctx.t.tr(S.hostOutdated));
    return { code: FAILURE_EXIT };
  }
  // Anything else on the way to a host (e.g. its log or run dir cannot be created): no host.
  say(ctx.proc, "stderr", ctx.t.tr(S.hostUnavailable)(hostLogPath(ctx.dataDir.path)));
  return { code: HOST_UNAVAILABLE_EXIT };
}

function requireFeature(ctx: Context, conn: HostConnection, feature: string): boolean {
  if (conn.host.features.includes(feature)) return true;
  conn.close();
  say(ctx.proc, "stderr", ctx.t.tr(S.hostOutdated));
  return false;
}

async function runCli(ctx: Context, argv: readonly string[]): Promise<MainOutcome> {
  let conn: HostConnection;
  try {
    conn = await reachHost(ctx.target, "cli");
  } catch (error) {
    return unreachable(ctx, error);
  }
  if (!requireFeature(ctx, conn, "cli.exec")) return { code: HOST_UNAVAILABLE_EXIT };
  let result: Awaited<ReturnType<typeof runExec>>;
  try {
    result = await runExec(conn, {
      argv,
      cwd: ctx.proc.cwd,
      env: ctx.env,
      terminal: ctx.proc.terminal,
      onInterrupt: ctx.proc.onInterrupt,
    });
  } catch (error) {
    conn.close();
    return unreachable(ctx, error);
  }
  conn.close();
  if (result.kind !== "exit") return unreachable(ctx, new ProtocolError("unexpected CLI reply"));
  return { code: result.code };
}

async function runMcp(ctx: Context, profile: string): Promise<MainOutcome> {
  const open = async (): Promise<HostConnection> => {
    const conn = await reachHost(ctx.target, "mcp", profile);
    if (!conn.host.features.includes("mcp.lines")) {
      conn.close();
      throw new HostConnectError("refused", "the host has no MCP sessions", "protocol");
    }
    await conn.call("mcp.open", { cwd: ctx.proc.cwd, env: forwardedEnv(ctx.env) });
    return conn;
  };
  let first: HostConnection;
  try {
    first = await open();
  } catch (error) {
    return unreachable(ctx, error);
  }
  return new Promise<MainOutcome>((resolve) => {
    const relay = new McpRelay({
      connect: open,
      writeLine: (line) => ctx.proc.terminal.write("stdout", `${line}\n`),
      writeErr: (text) => ctx.proc.terminal.write("stderr", text),
      exit: (code) => resolve({ code }),
      texts: { lost: bilingual(S.mcpLost), unavailable: bilingual(S.mcpUnavailable) },
    });
    relay.start(first);
    const stdin = ctx.proc.terminal.stdin;
    let rest = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) relay.clientLine(line);
    });
    stdin.on("end", () => {
      if (rest !== "") relay.clientLine(rest);
      relay.stdinEnd();
    });
  });
}

async function runHostAdmin(ctx: Context, action: "status" | "stop" | "run"): Promise<MainOutcome> {
  if (action === "run") {
    const { command, args } = hostCommand(
      ctx.target.build,
      ctx.dataDir.path,
      ctx.proc.execPath,
      ctx.proc.execArgv,
      ctx.proc.cwd,
    );
    const outcome = await runForeground({ command, args, env: ctx.target.env, cwd: ctx.proc.cwd });
    if (outcome.kind === "failed") return { code: FAILURE_EXIT };
    return outcome.kind === "signal" ? { signal: outcome.signal } : { code: outcome.code };
  }
  let conn: HostConnection | undefined;
  try {
    conn = await existingHost(ctx.target, "admin");
  } catch (error) {
    return unreachable(ctx, error);
  }
  if (conn === undefined) {
    say(ctx.proc, "stdout", ctx.t.tr(S.hostNotRunning));
    return { code: action === "status" ? NOT_RUNNING_EXIT : 0 };
  }
  try {
    if (action === "stop") {
      const closed = new Promise<void>((resolve) => conn.onClose(resolve));
      await conn.call("admin.stop");
      await closed;
      say(ctx.proc, "stdout", ctx.t.tr(S.hostStopped));
      return { code: 0 };
    }
    const s = adminStatusResultSchema.parse(await conn.call("admin.status"));
    const sessions = Object.entries(s.sessions)
      .map(([role, n]) => `${role} ${n}`)
      .join(", ");
    const lines = [
      ctx.t.tr(S.hostRunning)(s.pid, s.build, `${s.protocol.major}.${s.protocol.minor}`),
      ctx.t.tr(S.hostStarted)(s.startedAt),
      ctx.t.tr(S.hostSessions)(sessions),
      ctx.t.tr(S.hostStores)(String(s.vaults ?? "?"), String(s.pendingWrites ?? "?")),
      ctx.t.tr(S.hostSafeMode)(s.safeMode === true),
      ...(s.sync === undefined
        ? []
        : [
            ctx.t.tr(S.hostSync)(
              `${ctx.t.tr(S.hostSyncState)(s.sync.state)}${s.sync.reason === undefined ? "" : ` (${s.sync.reason})`}`,
              String(s.sync.pending ?? "?"),
              s.sync.lastRunAt ?? ctx.t.tr(S.hostSyncNever),
            ),
            ...s.sync.vaults.map((v) =>
              ctx.t.tr(S.hostSyncVault)(v.ordinal, v.leader, v.intentOpen, v.pipeSeq),
            ),
          ]),
      ...(s.stopping ? [ctx.t.tr(S.hostStopping)] : []),
    ];
    say(ctx.proc, "stdout", lines.join("\n"));
    return { code: 0 };
  } catch (error) {
    return unreachable(ctx, error);
  } finally {
    conn.close();
  }
}

/** The host's environment when the shim starts it: the shim's, `.env.dev` additions filled in. */
function hostEnv(
  env: NodeJS.ProcessEnv,
  added: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(added)) if (out[key] === undefined) out[key] = value;
  // A session's profile is its own business, not the host's.
  delete out.CASHU_PROFILE;
  return out;
}

export async function main(argv: readonly string[], proc: ShimProcess): Promise<MainOutcome> {
  let dataDir: ResolvedDataDir;
  try {
    dataDir = resolveDataDir({
      env: proc.env,
      platform: proc.platform,
      passwdHome: passwdHome(),
      cwd: proc.cwd,
      checkout: proc.build.checkout === undefined ? undefined : checkoutRoot(proc.build.checkout),
      flavor: proc.build.flavor,
    });
  } catch (error) {
    const t = createTranslator(
      createBackendI18n(nodeLanguageSource({ env: proc.env, dataDir: undefined })).appLanguage(),
    );
    say(proc, "stderr", t.tr(S.dataDirUnresolved)(error instanceof Error ? error.message : "?"));
    return { code: FAILURE_EXIT };
  }
  const env = foregroundEnv(proc.env, dataDir.devEnv.added);
  const t = createTranslator(
    createBackendI18n(nodeLanguageSource({ env, dataDir: dataDir.path })).appLanguage(),
  );
  const ctx: Context = {
    proc,
    dataDir,
    t,
    env,
    target: {
      dataDir: dataDir.path,
      build: proc.build,
      env: hostEnv(proc.env, dataDir.devEnv.added),
      execPath: proc.execPath,
      execArgv: proc.execArgv,
      cwd: proc.cwd,
    },
  };
  const r = route(argv);
  switch (r.kind) {
    case "app": {
      const target = desktopLaunch(proc.build, proc.execPath, proc.cwd, env, dataDir.path, r.debug);
      if (target === null) {
        say(proc, "stderr", t.tr(S.desktopUnavailable));
        return { code: HOST_UNAVAILABLE_EXIT };
      }
      const result = await runDesktopApp(target);
      if (result.kind === "failed") {
        say(proc, "stderr", t.tr(S.desktopUnavailable));
        return { code: HOST_UNAVAILABLE_EXIT };
      }
      return result.kind === "signal" ? { signal: result.signal } : { code: result.code };
    }
    case "host-usage":
      say(proc, "stderr", t.tr(S.hostUsage));
      return { code: USAGE_EXIT };
    case "host":
      return runHostAdmin(ctx, r.action);
    case "mcp":
      return runMcp(ctx, r.profile);
    case "cli":
      return runCli(ctx, argv);
  }
}

export function processShim(build: ShimBuild): ShimProcess {
  return {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    execPath: process.execPath,
    execArgv: process.execArgv,
    build,
    terminal: processTerminal(),
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      return () => process.off("SIGINT", handler);
    },
    exit(code) {
      process.stdout.write("", () => process.exit(code));
    },
  };
}
