// `cashu-host <command>`: the host's own entry (the `cashu host ...` commands of the shim, S56d, call
// the same protocol). Commands:
//   run     become the data dir's host (foreground; a detached spawn runs this too) until stopped,
//           idle, or handed over. Exit 0 clean, 3 another host owns the data dir, 75 handover.
//   status  ask the running host (role admin); exit 0 running, 3 not running. Never starts a host.
//   stop    ask the running host to stop; exit 0 stopped or not running.
// The data dir is `--data-dir <absolute path>` or CASHU_DATA_DIR; nothing else is guessed until the
// shim's data dir resolution lands (S56d). Output is English for operators; the shim maps exit codes to
// its localized texts (S56d).
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { adminStatusResultSchema } from "@cashu/host-protocol";
import { connectHost, HostBusyError, HostConnectError, RefusalError } from "@cashu/node-host";
import { startLocalHost } from "./host.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";

const USAGE_EXIT = 64;
const NOT_RUNNING_EXIT = 3;
const FAILURE_EXIT = 70;

const USAGE = `usage: cashu-host <run|status|stop> [--data-dir <absolute path>] [--linger-ms <ms>] [--bundle <file>]
  run     serve the data dir until stopped or idle (exit 0, 3 busy, 75 handover)
  status  show the running host (exit 0, 3 not running)
  stop    stop the running host`;

export interface MainEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** `run` installs SIGTERM / SIGINT handlers through this (tests pass a no-op). */
  readonly onSignal: (handler: () => void) => void;
  readonly build: string;
}

interface Args {
  readonly command: string;
  readonly dataDir: string;
  readonly lingerMs?: number;
  readonly bundle?: string;
}

function parse(argv: readonly string[], env: MainEnv["env"]): Args | string {
  const [command, ...rest] = argv;
  if (command === undefined) return "a command is required";
  let dataDir = env.CASHU_DATA_DIR;
  let lingerMs: number | undefined;
  let bundle: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) return `${flag} needs a value`;
    if (flag === "--data-dir") dataDir = value;
    else if (flag === "--linger-ms" && /^\d{1,10}$/.test(value)) lingerMs = Number(value);
    else if (flag === "--bundle" && isAbsolute(value)) bundle = value;
    else return `unknown or invalid flag ${flag}`;
  }
  if (dataDir === undefined || !isAbsolute(dataDir)) {
    return "the data dir must be an absolute path (--data-dir or CASHU_DATA_DIR)";
  }
  return {
    command,
    dataDir,
    ...(lingerMs === undefined ? {} : { lingerMs }),
    ...(bundle === undefined ? {} : { bundle }),
  };
}

async function admin(dataDir: string, build: string) {
  try {
    return await connectHost({ dataDir, role: "admin", build });
  } catch (error) {
    if (error instanceof HostConnectError && error.kind !== "refused") return undefined;
    throw error;
  }
}

/** Runs one command; resolves with the exit code. */
export async function main(argv: readonly string[], io: MainEnv): Promise<number> {
  const args = parse(argv, io.env);
  if (typeof args === "string") {
    io.stderr(`cashu-host: ${args}\n${USAGE}`);
    return USAGE_EXIT;
  }
  try {
    switch (args.command) {
      case "run": {
        if (args.bundle !== undefined) {
          try {
            const stat = lstatSync(args.bundle);
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              realpathSync(args.bundle) !== args.bundle
            )
              throw new Error("invalid bundle stamp");
          } catch {
            throw new RefusalError("--bundle must name an existing canonical regular file");
          }
        }
        const host = await startLocalHost({
          dataDir: args.dataDir,
          build: io.build,
          vaultSource: {
            kind: "native-production",
            factory: new ProductionVaultSourceFactory(args.dataDir),
          },
          ...(args.lingerMs === undefined ? {} : { lingerMs: args.lingerMs }),
          ...(args.bundle === undefined ? {} : { bundlePath: args.bundle }),
        });
        io.onSignal(() => void host.stop("signal"));
        io.stdout(`cashu-host: serving (pid ${process.pid}${host.safeMode ? ", safe mode" : ""})`);
        return await host.exit;
      }
      case "status": {
        const conn = await admin(args.dataDir, io.build);
        if (conn === undefined) {
          io.stdout("cashu-host: not running");
          return NOT_RUNNING_EXIT;
        }
        try {
          const s = adminStatusResultSchema.parse(await conn.call("admin.status"));
          const sessions = Object.entries(s.sessions)
            .map(([role, n]) => `${role} ${n}`)
            .join(", ");
          io.stdout(
            [
              `cashu-host: running (pid ${s.pid}, build ${s.build}, protocol ${s.protocol.major}.${s.protocol.minor})`,
              `  started   ${s.startedAt}`,
              `  sessions  ${sessions}`,
              `  vaults    ${s.vaults ?? "?"}, pending writes ${s.pendingWrites ?? "?"}`,
              `  safe mode ${s.safeMode === true ? "yes (no jobs, no network after repeated crashes)" : "no"}`,
              ...(s.sync === undefined
                ? []
                : [
                    `  sync      ${s.sync.state}${s.sync.reason === undefined ? "" : ` (${s.sync.reason})`}, pending ${s.sync.pending ?? "?"}, last run ${s.sync.lastRunAt ?? "never"}`,
                    ...s.sync.vaults.map(
                      (v) =>
                        `    vault ${v.ordinal}: leader ${v.leader ? "yes" : "no"}, intent ${v.intentOpen ? "open" : "closed"}, pipe ${v.pipeSeq}`,
                    ),
                  ]),
              ...(s.stopping ? ["  stopping"] : []),
            ].join("\n"),
          );
          return 0;
        } finally {
          conn.close();
        }
      }
      case "stop": {
        const conn = await admin(args.dataDir, io.build);
        if (conn === undefined) {
          io.stdout("cashu-host: not running");
          return 0;
        }
        const closed = new Promise<void>((resolve) => conn.onClose(resolve));
        await conn.call("admin.stop");
        await closed;
        io.stdout("cashu-host: stopped");
        return 0;
      }
      default:
        io.stderr(`cashu-host: unknown command\n${USAGE}`);
        return USAGE_EXIT;
    }
  } catch (error) {
    if (error instanceof HostBusyError) {
      io.stderr("cashu-host: another host owns this data dir");
      return error.exitCode;
    }
    if (error instanceof RefusalError) {
      io.stderr(`cashu-host: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof HostConnectError) {
      io.stderr(`cashu-host: ${error.message}`);
      return FAILURE_EXIT;
    }
    if (error instanceof Error) {
      const inventoryMessage: Record<string, string> = {
        native_setup_required: "native vault setup required",
        native_provisioning_pending: "native vault provisioning is incomplete",
        native_inventory_invalid: "native vault inventory is invalid",
        native_inventory_changed: "native vault inventory changed during startup",
      };
      const message = inventoryMessage[error.message];
      if (message) {
        io.stderr(`cashu-host: ${message}`);
        return FAILURE_EXIT;
      }
    }
    io.stderr(`cashu-host: failed (${error instanceof Error ? error.name : "error"})`);
    return FAILURE_EXIT;
  }
}
