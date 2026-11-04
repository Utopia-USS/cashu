// The `cashu` command tree, hosted (S56d): one commander program per run, built from native
// commands. Root options are the
// Python CLI's (`--profile/-p`, positional: only before the command name). A ported command receives
// the raw arguments after its name and parses them itself (S39 slices give their commands real
// commander options as they port them). Unknown syntax returns native usage guidance.
import type { Translator } from "@cashu/i18n";
import { Command, CommanderError } from "commander";
import { commandHelp } from "./help.js";
import { S } from "./strings.js";

/** What a command run in the host gets instead of a process. */
export interface CommandIo {
  /** The shim's working directory: relative file arguments resolve against it. */
  readonly cwd: string;
  readonly paths?: { readonly home: string };
  /** The forwarded environment subset (CASHU_*, locale, colour). */
  readonly env: Readonly<Record<string, string>>;
  readonly tty: {
    readonly stdin: boolean;
    readonly stdout: boolean;
    readonly stderr: boolean;
    readonly columns?: number;
    readonly compatible?: boolean;
  };
  /** Aborted when the user presses Ctrl-C (the command should stop and return 130). */
  readonly signal: AbortSignal;
  /** The command's language (its CASHU_LANG / locale, settings.json, the OS, English). */
  readonly t: Translator;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Asks the user's terminal; null when input ended or there is no terminal to ask. */
  prompt(text: string, options?: { readonly hidden?: boolean }): Promise<string | null>;
  /** The user's standard input, read on demand. */
  stdin(): AsyncIterable<Uint8Array>;
}

interface RootOptions {
  /** The root `--profile/-p` value, if given. */
  readonly profile?: string;
}

export interface PortedCommand {
  readonly name: string;
  /** Runs with the raw arguments after the command name; resolves with the exit code. */
  run(
    args: readonly string[],
    io: CommandIo,
    root: RootOptions,
  ): Promise<number | { readonly kind: "unhandled" }>;
}

export type TreeOutcome = { readonly kind: "exit"; readonly code: number };

const RETIRED = {
  "init-db": S.retiredInitDb,
  "migrate-data": S.retiredMigrateData,
  serve: S.retiredServe,
  outbox: S.retiredOutbox,
  secrets: S.retiredSecrets,
  sync: S.retiredSync,
} as const;

function unsupported(io: CommandIo): TreeOutcome {
  io.stderr(`${io.t.tr(S.unsupported)}\n`);
  return { kind: "exit", code: 2 };
}

/** The index of the command name in `argv`: the first token that is not a root option or its value. */
function commandIndex(argv: readonly string[]): number {
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg === "--profile" || arg === "-p") i += 2;
    else if (arg.startsWith("--profile=") || (arg.startsWith("-p") && !arg.startsWith("--")))
      i += 1;
    else return i;
  }
  return i;
}

const quiet = { writeOut: () => {}, writeErr: () => {}, outputError: () => {} };

function leaf(program: Command, name: string): Command {
  return program
    .command(name)
    .helpOption(false)
    .helpCommand(false)
    .passThroughOptions()
    .allowUnknownOption()
    .allowExcessArguments()
    .argument("[args...]");
}

/** Routes `argv` (after the program name) through the tree. */
export async function runTree(
  argv: readonly string[],
  io: CommandIo,
  ported: readonly PortedCommand[],
  defaultProfile?: () => string | undefined,
): Promise<TreeOutcome> {
  const at = commandIndex(argv);
  const name = argv[at];
  if (name === "--help" || name === "-h") {
    io.stdout(
      `${io.t.tr(S.rootHelp)(
        ported
          .map((command) => command.name)
          .sort()
          .join(", "),
      )}\n`,
    );
    return { kind: "exit", code: 0 };
  }
  if (name === undefined) {
    io.stderr(`${io.t.tr(S.missingCommand)}\n`);
    return { kind: "exit", code: 2 };
  }
  if (name === "mcp") {
    io.stderr(`${io.t.tr(S.mcpUsage)}\n`);
    return { kind: "exit", code: 2 };
  }
  if (Object.hasOwn(RETIRED, name)) {
    io.stderr(`${io.t.tr(RETIRED[name as keyof typeof RETIRED])}\n`);
    return { kind: "exit", code: 2 };
  }
  const command = ported.find((candidate) => candidate.name === name);
  const args = argv.slice(at + 1);
  const endOptions = args.indexOf("--");
  const helpAt = args.findIndex((arg) => arg === "--help" || arg === "-h");
  if (command && helpAt >= 0 && (endOptions < 0 || helpAt < endOptions)) {
    const help = commandHelp([
      name,
      ...args.slice(0, helpAt).filter((arg) => !arg.startsWith("-")),
    ]);
    if (help) {
      io.stdout(`${io.t.tr(help)}\n`);
      return { kind: "exit", code: 0 };
    }
  }
  let outcome: TreeOutcome = { kind: "exit", code: 2 };
  const program = new Command("cashu")
    .exitOverride()
    .configureOutput(quiet)
    .helpOption(false)
    .helpCommand(false)
    .enablePositionalOptions()
    .option("-p, --profile <slug>")
    .argument("[args...]")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      outcome = unsupported(io);
    });
  for (const command of ported) {
    leaf(program, command.name).action(async () => {
      const profile = program.opts<{ profile?: string }>().profile;
      const fallback = profile || io.env.CASHU_PROFILE ? undefined : defaultProfile?.();
      const commandIo =
        fallback === undefined ? io : { ...io, env: { ...io.env, CASHU_PROFILE: fallback } };
      const result = await command.run(
        argv.slice(at + 1),
        commandIo,
        profile === undefined ? {} : { profile },
      );
      outcome = typeof result === "number" ? { kind: "exit", code: result } : unsupported(io);
    });
  }
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return unsupported(io);
    throw error;
  }
  return outcome;
}
