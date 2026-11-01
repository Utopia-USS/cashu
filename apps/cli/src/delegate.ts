// TRANSITIONAL(S49): a command the host has not ported yet runs in the Python CLI, started by the shim
// with the shim's own terminal (stdin, stdout and stderr inherited), so its colours, prompts, hidden
// input and exit codes are exactly the Python CLI's. Its environment is the shim's plus what
// `.env.dev` adds (Python's own loader would add the same, so its data dir is the one the shim
// resolved even when the Python package lives elsewhere). SIGTERM sent to the shim is passed on
// (terminal signals reach the whole foreground group already); when the child dies of a signal the
// shim re-raises it, so the caller sees the same status as from the Python CLI itself.
import { spawn } from "node:child_process";

export interface DelegateOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/** Signals the shim survives while the child runs (the child gets them from the terminal itself). */
const GROUP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGQUIT", "SIGHUP"];

export type DelegateOutcome =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: NodeJS.Signals }
  | { readonly kind: "failed" };

export function runDelegate(options: DelegateOptions): Promise<DelegateOutcome> {
  return new Promise((resolve) => {
    const child = spawn(options.command, [...options.args], {
      stdio: "inherit",
      env: options.env,
      cwd: options.cwd,
    });
    const ignore = () => {};
    const forward = () => child.kill("SIGTERM");
    for (const signal of GROUP_SIGNALS) process.on(signal, ignore);
    process.on("SIGTERM", forward);
    const cleanup = () => {
      for (const signal of GROUP_SIGNALS) process.off(signal, ignore);
      process.off("SIGTERM", forward);
    };
    child.once("error", () => {
      cleanup();
      resolve({ kind: "failed" });
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(signal !== null ? { kind: "signal", signal } : { kind: "exit", code: code ?? 1 });
    });
  });
}

/** The child's environment: the shim's, `.env.dev` additions filled in (never overriding). */
export function delegateEnv(
  env: NodeJS.ProcessEnv,
  added: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(added)) if (out[key] === undefined) out[key] = value;
  // The packaged shim runs as the app's binary in Node mode; the Python CLI must not inherit that.
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}
