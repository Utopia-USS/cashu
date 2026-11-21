// The shim's signal handling around a foreground child (`cashu host run`, `cashu app`), per platform.
// POSIX: the terminal sends SIGINT / SIGQUIT / SIGHUP to the whole foreground process group, so the
// shim ignores them and lets the child decide; when the child dies of a signal the shim re-raises it,
// so the caller sees the same signal death. Windows: Ctrl+C, Ctrl+Break and closing the console reach
// every process attached to the console (SIGINT, SIGBREAK, SIGHUP in Node), so the same three are
// ignored; a signal cannot be re-raised there (process.kill on itself is TerminateProcess with code 1),
// so the shim exits with the code a shell reports for that signal death instead (128 + its number).
import { constants } from "node:os";

const POSIX_GROUP: readonly NodeJS.Signals[] = ["SIGINT", "SIGQUIT", "SIGHUP"];
const WINDOWS_CONSOLE: readonly NodeJS.Signals[] = ["SIGINT", "SIGBREAK", "SIGHUP"];

/** The signals the terminal delivers to the shim and its foreground child alike. */
export function sharedSignals(platform: NodeJS.Platform): readonly NodeJS.Signals[] {
  return platform === "win32" ? WINDOWS_CONSOLE : POSIX_GROUP;
}

/** Signal numbers where this Node build does not define one (Windows has no SIGQUIT, POSIX no SIGBREAK). */
const KNOWN_NUMBERS: Readonly<Partial<Record<NodeJS.Signals, number>>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
  SIGBREAK: 21,
};

/** The exit code shells report for a death by `signal`: 128 + its number (1 when it has none). */
export function signalExitCode(signal: NodeJS.Signals): number {
  const number = constants.signals[signal] ?? KNOWN_NUMBERS[signal];
  return number === undefined ? 1 : 128 + number;
}

/** How the shim ends after its foreground child died of `signal`. */
export type SignalEnding =
  | { readonly kind: "raise"; readonly signal: NodeJS.Signals }
  | { readonly kind: "exit"; readonly code: number };

export function signalEnding(signal: NodeJS.Signals, platform: NodeJS.Platform): SignalEnding {
  return platform === "win32"
    ? { kind: "exit", code: signalExitCode(signal) }
    : { kind: "raise", signal };
}
