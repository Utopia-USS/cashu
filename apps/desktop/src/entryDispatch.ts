import { processFlavor } from "@cashu/node-host/flavor";

/** Exit code of a refused command-line invocation (EX_USAGE). */
const COMMAND_REFUSED = 64;

/** Select a one-shot helper before importing any ordinary desktop startup module. */
export async function dispatchDesktopEntry(
  args: readonly string[],
  actions: {
    registerAppScheme?(): void;
    registerEarlyResponses(): void;
    loadMain(): Promise<unknown>;
    runHelper(): Promise<number>;
    refuseCommand?(command: string): void;
  },
): Promise<number | null> {
  // The Python app's executable `Contents/MacOS/cashu` has the same path as this one on a
  // case-insensitive volume, so a leftover Python launch agent or MCP registration (`cashu worker
  // ...`, `cashu mcp --profile ...`) lands here. A positional command never opens the window: the
  // native CLI is the shim (`ELECTRON_RUN_AS_NODE=1 ... shim.mjs`), not this executable. A bare
  // `cashu://` link (a second launch, the flavor's own scheme) is not a command.
  const command = args[0];
  const link = `${processFlavor().urlScheme}:`;
  if (
    command !== undefined &&
    !command.startsWith("-") &&
    command.slice(0, link.length).toLowerCase() !== link
  ) {
    actions.refuseCommand?.(command);
    return COMMAND_REFUSED;
  }
  if (args.length === 1 && args[0] === "--notify-helper") {
    try {
      return await actions.runHelper();
    } catch {
      return 2;
    }
  }
  if (args.includes("--notify-helper")) return 2;
  actions.registerAppScheme?.();
  actions.registerEarlyResponses();
  await actions.loadMain();
  return null;
}
