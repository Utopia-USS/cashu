// The stable launcher `<data dir>/bin/cashu` (S56 spec 4): a tiny sh script that runs this install's
// `cashu` shim, rewritten by the host at every start (and by the app at launch, S47). `.mcp.json` lines
// (S46) and scripts point at it, so moving or updating cashU.app never breaks them. Written with a
// temp file + rename (0700, in a 0700 dir); left alone when already current.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "@cashu/node-host";
import type { Program } from "./runtime.js";

/** POSIX sh single-quoting. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function launcherScript(program: Program): string {
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

export const launcherPath = (dataDir: string) => join(dataDir, "bin", "cashu");

/** Writes the launcher if it differs; returns whether it changed. */
export function writeLauncher(dataDir: string, program: Program): boolean {
  const path = launcherPath(dataDir);
  const script = launcherScript(program);
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
