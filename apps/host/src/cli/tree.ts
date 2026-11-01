// The `cashu` command tree, hosted (S56d): one commander program per run, built from the ported
// commands (run here, in the host) and the delegated table (answered `delegate`). Root options are the
// Python CLI's (`--profile/-p`, positional: only before the command name). A ported command receives
// the raw arguments after its name and parses them itself (S39 slices give their commands real
// commander options as they port them). Anything the tree does not know (no command, an unknown
// command, root `--help`, a root parse error) is delegated, so the Python CLI answers it byte for byte
// until the last slice lands (TRANSITIONAL(S49)).
import type { Translator } from "@cashu/i18n";
import { Command, CommanderError } from "commander";

/** What a command run in the host gets instead of a process. */
export interface CommandIo {
  /** The shim's working directory: relative file arguments resolve against it. */
  readonly cwd: string;
  /** The forwarded environment subset (CASHU_*, locale, colour). */
  readonly env: Readonly<Record<string, string>>;
  readonly tty: {
    readonly stdin: boolean;
    readonly stdout: boolean;
    readonly stderr: boolean;
    readonly columns?: number;
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
  run(args: readonly string[], io: CommandIo, root: RootOptions): Promise<number>;
}

export type TreeOutcome =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "delegate" };

const DELEGATE: TreeOutcome = { kind: "delegate" };

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
  delegated: Readonly<Record<string, string>>,
): Promise<TreeOutcome> {
  let outcome: TreeOutcome = DELEGATE;
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
      outcome = DELEGATE;
    });
  for (const command of ported) {
    leaf(program, command.name).action(async () => {
      const at = commandIndex(argv);
      const profile = program.opts<{ profile?: string }>().profile;
      const code = await command.run(
        argv.slice(at + 1),
        io,
        profile === undefined ? {} : { profile },
      );
      outcome = { kind: "exit", code };
    });
  }
  for (const name of Object.keys(delegated)) {
    leaf(program, name).action(() => {
      outcome = DELEGATE;
    });
  }
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return DELEGATE;
    throw error;
  }
  return outcome;
}
