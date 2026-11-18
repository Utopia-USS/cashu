// The `cashu` command the recovery prompt and screen tell the user to run, in the exact form that
// works on this install. Paths under the home folder are shown `~`-relative; an app bundle under
// /Applications is shown as it is (it names no person). Anything else becomes a placeholder.
//   launcher  the stable launcher every host start rewrites exists (`launcherPath`)
//   packaged  the app's own binary in Node mode on its `Resources/shim.mjs` (macOS and Linux)
//   checkout  a source checkout: `pnpm cashu-next` from the repository root
// macOS and Linux render the command for sh-compatible shells (`~/"..."`). Windows renders it for
// PowerShell, the default shell of Windows Terminal and of agents on Windows, and the one whose quoting
// is predictable: inside double quotes only `$`, a backtick and `"` are special, and no displayed path
// component contains them, while cmd.exe expands `%` and `!` even inside quotes. The home folder is
// `$env:USERPROFILE` there (what Node reports as the home on Windows).
import { cmdLineSafe } from "@cashu/domain/core";
import { z } from "zod";
import { DISPLAY_PATH, homeRelativePath, OUTSIDE_HOME } from "./redaction.js";

const COMPONENT = "(?!\\.{1,2}(?:/|$))[A-Za-z0-9 ._()-]{1,64}";
/** An absolute path of plain components under /Applications. */
const APPLICATIONS_PATH = new RegExp(`^/Applications(?:/${COMPONENT})+$`);

const displayPath = z.string().max(512).regex(DISPLAY_PATH);
const appPath = z
  .string()
  .max(512)
  .refine((value) => DISPLAY_PATH.test(value) || APPLICATIONS_PATH.test(value));

export const recoveryCommandSchema = z.discriminatedUnion("kind", [
  // `shell` absent: an sh-compatible shell (macOS, Linux and reports written before Windows).
  z.strictObject({
    kind: z.literal("launcher"),
    path: displayPath,
    shell: z.literal("powershell").optional(),
  }),
  z.strictObject({ kind: z.literal("packaged"), binary: appPath, shim: appPath }),
  z.strictObject({ kind: z.literal("checkout"), shell: z.literal("powershell").optional() }),
]);
export type RecoveryCommand = z.infer<typeof recoveryCommandSchema>;

/** An app path for display: `~`-relative inside home, as it is under /Applications, else a placeholder. */
export function appDisplayPath(path: string, home: string): string {
  const relative = homeRelativePath(path, home);
  if (relative !== OUTSIDE_HOME) return relative;
  return APPLICATIONS_PATH.test(path) ? path : OUTSIDE_HOME;
}

/**
 * The stable launcher in `dataDir` (written by the host at every start, apps/host launcher.ts):
 * `<data dir>/bin/cashu`, an sh script, on macOS and Linux; `<data dir>\bin\cashu.cmd` on Windows.
 * `platform` is `process.platform` of the process that asks.
 */
export function launcherPath(dataDir: string, platform: string): string {
  if (platform === "win32") return `${dataDir.replace(/[\\/]+$/, "")}\\bin\\cashu.cmd`;
  return `${dataDir.replace(/\/+$/, "")}/bin/cashu`;
}

export interface RecoveryCommandInput {
  readonly home: string;
  /** `launcherPath(<data dir>, platform)` when that file exists. */
  readonly launcher: string | null;
  /** `process.platform` of the app; absent: macOS or Linux (an sh-compatible shell). */
  readonly platform?: string;
  readonly isPackaged: boolean;
  /** The app binary (`process.execPath`) and its `Resources/shim.mjs` of a packaged app. */
  readonly binary: string;
  readonly shim: string;
}

/**
 * Windows: the launcher, or a checkout. A packaged app has no inline form there (PowerShell cannot set
 * ELECTRON_RUN_AS_NODE for a command in argument position, as after `claude mcp add ... --`); the host
 * writes the launcher at every start, so it exists for any install that ever started. The prompt
 * registers the form as an MCP server, which Claude Code starts through `cmd /c` on Windows
 * (`claudeMcpAddLine`), so a launcher whose real path holds a character cmd.exe interprets has no
 * form there (`cmdLineSafe`), as on the setup card.
 */
function windowsRecoveryCommand(input: RecoveryCommandInput): RecoveryCommand | null {
  if (input.launcher !== null && cmdLineSafe(input.launcher)) {
    const path = homeRelativePath(input.launcher, input.home);
    if (path !== OUTSIDE_HOME) return { kind: "launcher", path, shell: "powershell" };
  }
  return input.isPackaged ? null : { kind: "checkout", shell: "powershell" };
}

/** The command form to show, or null when no form can be shown without a private path. */
export function recoveryCommand(input: RecoveryCommandInput): RecoveryCommand | null {
  if (input.platform === "win32") return windowsRecoveryCommand(input);
  if (input.launcher !== null) {
    const path = homeRelativePath(input.launcher, input.home);
    if (path !== OUTSIDE_HOME) return { kind: "launcher", path };
  }
  if (!input.isPackaged) return { kind: "checkout" };
  const binary = appDisplayPath(input.binary, input.home);
  const shim = appDisplayPath(input.shim, input.home);
  return binary === OUTSIDE_HOME || shim === OUTSIDE_HOME
    ? null
    : { kind: "packaged", binary, shim };
}

/** A display path as a shell word: `~/"rest"` keeps the tilde expanding, the rest is quoted. */
function shellWord(path: string): string {
  if (path === "~") return "~";
  if (path.startsWith("~/")) return `~/"${path.slice(2)}"`;
  return `"${path}"`;
}

/**
 * A display path as one PowerShell argument: `"$env:USERPROFILE\rest"` (the variable expands inside
 * double quotes; a display path holds no `$`, backtick or `"`).
 */
function powershellWord(path: string): string {
  if (path === "~") return '"$env:USERPROFILE"';
  if (path.startsWith("~/")) return `"$env:USERPROFILE\\${path.slice(2).replaceAll("/", "\\")}"`;
  return `"${path}"`;
}

/**
 * The `process.platform` whose shell `command` is written for: "win32" for a PowerShell form, absent
 * for an sh-compatible one (macOS, Linux, a report written before Windows, or no known form).
 */
export function commandPlatform(command: RecoveryCommand | null): "win32" | undefined {
  return command !== null && command.kind !== "packaged" && command.shell === "powershell"
    ? "win32"
    : undefined;
}

/**
 * The command prefix to put before a `cashu` subcommand (plain `cashu` when no form is known), as an
 * argument (after `claude mcp add <name> --`) or, in an sh-compatible shell, as the command itself.
 */
export function commandPrefix(command: RecoveryCommand | null): string {
  if (command === null) return "cashu";
  switch (command.kind) {
    case "launcher":
      return command.shell === "powershell"
        ? powershellWord(command.path)
        : shellWord(command.path);
    case "packaged":
      return `ELECTRON_RUN_AS_NODE=1 ${shellWord(command.binary)} ${shellWord(command.shim)}`;
    case "checkout":
      return "pnpm cashu-next";
  }
}
