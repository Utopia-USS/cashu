// The `cashu` command the recovery prompt and screen tell the user to run, in the exact form that
// works on this install. Paths under the home folder are shown `~`-relative; an app bundle under
// /Applications is shown as it is (it names no person). Anything else becomes a placeholder.
//   launcher  `<data dir>/bin/cashu` exists (the stable launcher every start rewrites)
//   packaged  the app's own binary in Node mode on its `Resources/shim.mjs`
//   checkout  a source checkout: `pnpm cashu-next` from the repository root
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
  z.strictObject({ kind: z.literal("launcher"), path: displayPath }),
  z.strictObject({ kind: z.literal("packaged"), binary: appPath, shim: appPath }),
  z.strictObject({ kind: z.literal("checkout") }),
]);
export type RecoveryCommand = z.infer<typeof recoveryCommandSchema>;

/** An app path for display: `~`-relative inside home, as it is under /Applications, else a placeholder. */
export function appDisplayPath(path: string, home: string): string {
  const relative = homeRelativePath(path, home);
  if (relative !== OUTSIDE_HOME) return relative;
  return APPLICATIONS_PATH.test(path) ? path : OUTSIDE_HOME;
}

export interface RecoveryCommandInput {
  readonly home: string;
  /** `<data dir>/bin/cashu` when that file exists. */
  readonly launcher: string | null;
  readonly isPackaged: boolean;
  /** The app binary (`process.execPath`) and its `Resources/shim.mjs` of a packaged app. */
  readonly binary: string;
  readonly shim: string;
}

/** The command form to show, or null when no form can be shown without a private path. */
export function recoveryCommand(input: RecoveryCommandInput): RecoveryCommand | null {
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

/** The command prefix to put before `migrate` (plain `cashu` when no form is known). */
export function commandPrefix(command: RecoveryCommand | null): string {
  if (command === null) return "cashu";
  switch (command.kind) {
    case "launcher":
      return shellWord(command.path);
    case "packaged":
      return `ELECTRON_RUN_AS_NODE=1 ${shellWord(command.binary)} ${shellWord(command.shim)}`;
    case "checkout":
      return "pnpm cashu-next";
  }
}
