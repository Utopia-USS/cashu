// The stable launcher (S56 spec 4) that runs this install's `cashu` shim, rewritten by the host at
// every start (and by the app at launch, S47). Scripts and the Settings lines point at it, so moving or
// updating the app never breaks them. Written with a temp file + rename (0700, in a 0700 dir); left
// alone when already current. Where it lives is `launcherPath` (@cashu/host-protocol/startup-failure,
// shared with Electron main):
//   macOS, Linux  `<data dir>/bin/cashu`: a POSIX sh script, every word single-quoted.
//   Windows       `<data dir>\bin\cashu.cmd` (C6): a cmd script with CRLF line ends,
//                   @echo off / setlocal DisableDelayedExpansion / set "K=V"... /
//                   "<command>" "<arg>"... %* & call exit /b %%ERRORLEVEL%%
// Delayed expansion is switched off explicitly: a user can turn it on for every cmd.exe in the
// registry (Command Processor\DelayedExpansion), and then a `!` in a path or argument would be
// expanded as a variable reference.
// cmd.exe reads a script line by line at byte offsets while it runs, so a launcher rewritten during a
// long `cashu mcp` session would otherwise be read on from the old offset after the program returns.
// The program call and the `exit /b` share one line, parsed whole before the program starts, so
// nothing after it is ever read.
// The exit code: the `exit /b` must carry the program's code as a number. A bare `exit /b` leaves
// ERRORLEVEL set, but `cmd /c launcher.cmd` (how Node, PowerShell and agents run a .cmd) exits with
// the return code of the last command, and a bare `exit /b` returns 0 there (seen on windows-latest:
// a program exiting 7 gave 0). `exit /b %ERRORLEVEL%` cannot be written on that line either: a line's
// `%` references are expanded once when it is read, before the program has run. So the line holds
// `%%ERRORLEVEL%%`, which that first expansion turns into the text `%ERRORLEVEL%`, and CALL expands
// its command once more when it runs, after the program: `call exit /b 7`. CALL of an internal
// command runs it in the current batch context (only `call :label` opens a new one), so that `exit
// /b 7` ends the launcher with 7, read by `cmd /c` as its exit code, by a calling batch (`call
// cashu.cmd`) as ERRORLEVEL and by PowerShell as $LASTEXITCODE. Only the CALL's own command is
// expanded again, never the program's arguments (`%*`).
// cmd.exe treats everything inside double quotes literally except `%` (variable expansion) and `"`
// (the end of the quote), so a value holding either, a CR, LF or NUL is refused, and so is an env key
// outside [A-Za-z_][A-Za-z0-9_]*. An argument's trailing backslashes are doubled so the program's own
// command-line parsing (CommandLineToArgvW rules) never reads `\"` as an escaped quote. cmd.exe decodes
// a script in the console code page, not UTF-8, so a value with non-ASCII text (an install under a
// profile folder like `C:\Users\Michał`) is written relative to `%LOCALAPPDATA%` or `%USERPROFILE%`
// when it lies under one (cmd.exe expands those in full Unicode at run time); any other non-ASCII value
// is refused. A refused launcher is logged by the caller, never written.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launcherPath } from "@cashu/host-protocol/startup-failure";
import { ensurePrivateDir } from "@cashu/node-host";
import type { Program } from "./runtime.js";

export { launcherPath };

/** What the launcher is written for: the platform and the environment of the user who runs it. */
export interface LauncherTarget {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const processTarget = (): LauncherTarget => ({ platform: process.platform, env: process.env });

/** A program value the Windows launcher cannot carry safely. */
export class LauncherValueError extends Error {
  constructor(what: string) {
    super(`the launcher cannot carry this ${what} safely`);
    this.name = "LauncherValueError";
  }
}

/** POSIX sh single-quoting. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function posixScript(program: Program): string {
  const env = Object.entries(program.env ?? {}).map(([k, v]) => `export ${k}=${quote(v)}\n`);
  const argv = [program.command, ...program.args].map(quote).join(" ");
  return [
    "#!/bin/sh\n",
    "# cashU stable launcher: runs this install's `cashu` command (CLI and `cashu mcp`).\n",
    "# Rewritten by cashU at every start; edits are lost.\n",
    ...env,
    `exec ${argv} "$@"\n`,
  ].join("");
}

const CMD_UNSAFE = /["%\r\n\0]/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASCII = /^[\x20-\x7e]*$/;
/** The per-user folders cmd.exe expands at run time, the more specific first. */
const WINDOWS_ROOTS = ["LOCALAPPDATA", "USERPROFILE"] as const;

/**
 * `value` for a cmd script: refused when it holds a character cmd.exe would interpret; non-ASCII text
 * only as the rest of a path under one of `WINDOWS_ROOTS`, written as `%ROOT%\rest`.
 */
function cmdValue(value: string, what: string, env: LauncherTarget["env"]): string {
  if (CMD_UNSAFE.test(value)) throw new LauncherValueError(what);
  if (ASCII.test(value)) return value;
  for (const name of WINDOWS_ROOTS) {
    const root = env[name]?.replace(/[\\/]+$/, "");
    if (root === undefined || !/^[A-Za-z]:$|^[A-Za-z]:[\\/]|^\\\\/.test(root)) continue;
    const head = value.slice(0, root.length);
    const next = value.charAt(root.length);
    if (head.toLowerCase() !== root.toLowerCase() || (next !== "\\" && next !== "/")) continue;
    const rest = value.slice(root.length);
    if (ASCII.test(rest)) return `%${name}%${rest}`;
  }
  throw new LauncherValueError(what);
}

function windowsScript(program: Program, env: LauncherTarget["env"]): string {
  const lines = ["@echo off", "setlocal DisableDelayedExpansion"];
  for (const [key, value] of Object.entries(program.env ?? {})) {
    if (!ENV_KEY.test(key)) throw new LauncherValueError("variable name");
    lines.push(`set "${key}=${cmdValue(value, "variable", env)}"`);
  }
  const command = cmdValue(program.command, "command", env);
  if (command === "" || command.endsWith("\\")) throw new LauncherValueError("command");
  const args = program.args.map((arg) => cmdValue(arg, "argument", env).replace(/\\+$/, "$&$&"));
  const words = [command, ...args].map((word) => `"${word}"`);
  lines.push(`${words.join(" ")} %* & call exit /b %%ERRORLEVEL%%`);
  return lines.map((line) => `${line}\r\n`).join("");
}

/** The launcher's text for `target` (throws `LauncherValueError` for a value it cannot carry). */
export function launcherScript(program: Program, target: LauncherTarget): string {
  return target.platform === "win32" ? windowsScript(program, target.env) : posixScript(program);
}

/** Writes the launcher if it differs; returns whether it changed. */
export function writeLauncher(
  dataDir: string,
  program: Program,
  target: LauncherTarget = processTarget(),
): boolean {
  const path = launcherPath(dataDir, target.platform);
  const script = launcherScript(program, target);
  try {
    if (readFileSync(path, "utf8") === script) return false;
  } catch {
    // missing: write it
  }
  ensurePrivateDir(join(dataDir, "bin"));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, script, { mode: 0o700 });
  renameSync(tmp, path);
  return true;
}
