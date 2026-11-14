// Run the native host in the foreground for `cashu host run`, inheriting this terminal.
import { spawn } from "node:child_process";

export interface ForegroundOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

const GROUP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGQUIT", "SIGHUP"];

export type ForegroundOutcome =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: NodeJS.Signals }
  | { readonly kind: "failed" };

export function runForeground(options: ForegroundOptions): Promise<ForegroundOutcome> {
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

/** Merge `.env.dev` values without overriding the caller's environment. */
export function foregroundEnv(
  env: NodeJS.ProcessEnv,
  added: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(added)) if (out[key] === undefined) out[key] = value;
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}
