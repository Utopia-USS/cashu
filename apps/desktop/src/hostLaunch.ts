/// <reference types="node" />
// How the shell starts the data dir's local host when none answers (S56 section 5): a detached child
// (node-host `spawnDetachedHost`: own session, stdin closed, output to `<data dir>/logs/host.log`),
// run by this app's own Electron binary in Node mode, so no second runtime ships. The host outlives
// the window on purpose (on demand: it lingers while idle, then exits by itself).
//   dev       Electron as Node + type stripping on apps/host/src/cli.ts (the documented dev entry)
//   packaged  Electron as Node on the bundled `Resources/host.mjs` (bundled by packaging, S47)
import { join } from "node:path";

/** The bundled host next to the app's resources (S47 packaging). */
export const PACKAGED_HOST_ENTRY = "host.mjs";

export interface HostLaunchInput {
  /** The repo checkout of a dev shell (`repoRoot`). */
  readonly root: string;
  readonly dataDir: string;
  /** This Electron binary (`process.execPath`). */
  readonly execPath: string;
  readonly isPackaged: boolean;
  /** `process.resourcesPath` of a packaged app. */
  readonly resourcesPath: string;
  readonly env: NodeJS.ProcessEnv;
  /** This shell's build id; the host reports it in its handshake and status. */
  readonly build: string;
}

export interface HostLaunch {
  readonly command: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
}

export function hostLaunch(input: HostLaunchInput): HostLaunch {
  const env = { ...input.env };
  if (input.isPackaged) {
    for (const key of Object.keys(env)) {
      if (
        key.startsWith("PYTHON") ||
        key.startsWith("_PYI_") ||
        key.startsWith("PYINSTALLER_") ||
        key.startsWith("DYLD_") ||
        key.startsWith("LD_")
      )
        delete env[key];
    }
  }
  const entry = input.isPackaged
    ? [join(input.resourcesPath, PACKAGED_HOST_ENTRY)]
    : [
        "--disable-warning=ExperimentalWarning",
        "--import",
        join(input.root, "tools", "node-ts", "resolveTs.ts"),
        join(input.root, "apps", "host", "src", "cli.ts"),
      ];
  return {
    command: input.execPath,
    args: [
      ...entry,
      "run",
      "--data-dir",
      input.dataDir,
      ...(input.isPackaged ? ["--bundle", join(input.resourcesPath, PACKAGED_HOST_ENTRY)] : []),
    ],
    env: {
      ...env,
      CASHU_DATA_DIR: input.dataDir,
      ELECTRON_RUN_AS_NODE: "1",
      CASHU_BUILD: input.build,
    },
  };
}
