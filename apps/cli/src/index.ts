// `cashu-next` (the package bin): the lab / dev CLI of the TypeScript stack (no CLI framework until
// S39 picks one). It runs under Node's type stripping with the shared resolve hook, which maps the
// `./x.js` specifiers of the workspace packages to `./x.ts`:
//   node --experimental-strip-types --import <repo>/tools/node-ts/resolveTs.ts apps/cli/src/index.ts <command> ...
// or `pnpm cashu-next <command> ...` from the repo root (paths must be absolute).
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { type CliEnv, genesisCommand } from "./genesis/command.ts";

const USAGE =
  "usage: cashu-next <command> ...\ncommands: genesis (cashu-next genesis without flags prints its usage)";

/** The real process surroundings. */
function processEnv(): CliEnv {
  return {
    home: homedir(),
    tmpDir: tmpdir(),
    pid: process.pid,
    now: () => Date.now(),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

/** Dispatches `argv` (without node and the script); returns the exit code. */
export function main(argv: readonly string[], env: CliEnv = processEnv()): number {
  const [command, ...rest] = argv;
  if (command === "genesis") return genesisCommand(rest, env);
  env.stderr(USAGE);
  return 64;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
