// After a successful `cashu migrate`: retire the launchd worker agents the Python app installed
// (`io.utopiasoft.cashu.worker`, legacy `io.github.synszakala.finanse.worker`; ab24ab6
// `core/worker/scheduler.py`). Once the native bundle replaced the Python one they would call the
// native executable every day (`Contents/MacOS/cashu` and `cashU` are one file on a case-insensitive
// disk). For each of exactly these labels whose `<agents dir>/<label>.plist` exists: `launchctl bootout
// gui/<uid>/<label>` (a "not loaded" answer is fine), then the plist is removed. Idempotent; never a
// glob, never another label (the native host agent `io.utopiasoft.cashu.host` is never touched).
//
// Safety: the real default dir (`~/Library/LaunchAgents`) is touched, and launchctl run through the
// injected runner, only when ALL of these hold: the process is a packaged app (not a source checkout)
// of a flavor that replaces the Python install (prod), not a sealed test build, `CASHU_TESTING` is not
// "1", `CASHU_LAUNCH_AGENTS_DIR` is unset, the home is the account's own, and the imported data dir is
// (canonically, so case and symlinks cannot fool it) the account's default data dir of that flavor
// (`<account home>/Library/Application Support/cashU`), the one the Python worker served. Any other
// import (a demo or synthetic data dir, a dev run, a temp HOME) leaves it alone (`skipped`). With
// `CASHU_LAUNCH_AGENTS_DIR` set only the plists in that dir are removed (bootout skipped), in any
// runtime. host main.ts wires the real runner only for a packaged, prod-flavor, non-test runtime
// (`productionLaunchctl`). Plists are never parsed.
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  PYTHON_AGENT_LABELS,
  type PythonAgentLabel,
  type PythonAgentRetirement,
} from "@cashu/host-protocol/startup-failure";
import type { Flavor } from "@cashu/node-host/flavor";

/** Python's `LAUNCH_AGENTS_ENV`: the agents dir override (tests and the e2e use a temp dir). */
const LAUNCH_AGENTS_ENV = "CASHU_LAUNCH_AGENTS_DIR";

/** Runs `argv` (argv[0] is `/bin/launchctl`); resolves its exit status (null: it did not run). */
export type LaunchctlRunner = (argv: readonly string[]) => number | null;

/** The real runner: `/bin/launchctl` without a shell, output ignored, bounded in time. */
export const systemLaunchctl: LaunchctlRunner = (argv) => {
  const [command, ...args] = argv;
  if (command !== "/bin/launchctl") return null;
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 15_000 });
  return result.error === undefined ? result.status : null;
};

/** What the running app is, as far as the real bootout cares (host main.ts; tests inject it). */
export interface RetireRuntime {
  /** The process runs from a packaged app bundle, not from a source checkout. */
  readonly packaged: boolean;
  /** This process's flavor (`processFlavor()`): its table entry, never its name. */
  readonly flavor: Pick<Flavor, "inheritsPythonInstall" | "dataDirName">;
}

/**
 * The runner `migrate` gets: the real one only on macOS for a packaged app of a flavor that replaces
 * the Python install and is not a sealed test build; null for a source run, staging or a test build.
 */
export function productionLaunchctl(facts: {
  readonly platform: NodeJS.Platform;
  readonly runtime: RetireRuntime;
  readonly testBuild: boolean;
}): LaunchctlRunner | null {
  return facts.platform === "darwin" &&
    facts.runtime.packaged &&
    facts.runtime.flavor.inheritsPythonInstall &&
    !facts.testBuild
    ? systemLaunchctl
    : null;
}

/**
 * launchctl's answers to a bootout of a service that is not loaded: ESRCH (3, "No such process") and
 * 113 ("Could not find specified service"); both mean there is nothing left to stop.
 */
const NOT_LOADED = new Set([3, 113]);

export interface RetireInput<L extends string = string> {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home (the default agents dir is `<home>/Library/LaunchAgents`). */
  readonly home: string;
  /**
   * The data dir just imported (or found already imported). The real default agents dir is touched
   * only when it is canonically the account's default data dir of `runtime.flavor`.
   */
  readonly dataDir: string;
  /** The running app (host main.ts). Absent: a source or test run; the real default dir stays closed. */
  readonly runtime?: RetireRuntime;
  /** The user's uid (`gui/<uid>`). */
  readonly uid: number;
  /** The launchctl runner; null (tests, non-macOS) never boots anything out. */
  readonly launchctl: LaunchctlRunner | null;
  /**
   * The labels to retire. Production always uses PYTHON_AGENT_LABELS; only the manual proof injects
   * a throwaway `cashu-next-test.retire.<hex>` label.
   */
  readonly labels: readonly L[];
  /**
   * The account's home from the user database (default `os.userInfo().homedir`); the real default dir
   * is used only when `home` resolves to it. Tests inject their temp home here.
   */
  readonly accountHome?: string;
  /**
   * The running app is a sealed test build (@cashu/node-host/test-build): launchctl never runs and
   * only an explicit `CASHU_LAUNCH_AGENTS_DIR` is acted on; the real default dir is never touched.
   */
  readonly testBuild?: boolean;
}

/** One label's outcome (the protocol narrows `label` to the two Python labels). */
interface AgentOutcome<L extends string = string> {
  readonly label: L;
  readonly state: "retired" | "absent" | "failed" | "skipped";
}

export interface Retirement<L extends string = string> {
  readonly bootout: "ran" | "skipped";
  readonly agents: AgentOutcome<L>[];
}

type PlistState = "present" | "absent" | "unreadable";

function plistState(path: string): PlistState {
  try {
    const stat = lstatSync(path);
    // A directory under a plist's name is nothing launchd loads, and not ours to remove.
    return stat.isDirectory() ? "unreadable" : "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

/**
 * True when `home` is the account's home from the user database (not a HOME override). The native
 * realpath resolves symlinks and gives each component's on-disk case, so the comparison holds on a
 * case-insensitive disk.
 */
function isAccountHome(home: string, accountHome: string | undefined): boolean {
  try {
    return realpathSync.native(home) === realpathSync.native(accountHome ?? userInfo().homedir);
  } catch {
    return false;
  }
}

/**
 * True when `dataDir` is canonically `<account home>/Library/Application Support/<flavor's dir>`, the
 * data dir the Python app (and its worker) used. A missing dir on either side is never a match.
 */
function isAccountDefaultDataDir(
  dataDir: string,
  accountHome: string | undefined,
  runtime: RetireRuntime,
): boolean {
  try {
    const expected = join(
      accountHome ?? userInfo().homedir,
      "Library",
      "Application Support",
      runtime.flavor.dataDirName.darwin,
    );
    return realpathSync.native(dataDir) === realpathSync.native(expected);
  } catch {
    return false;
  }
}

/** Retires the given launchd agents; never throws (a failure is a `failed` outcome). */
export function retireLaunchAgents<L extends string>(input: RetireInput<L>): Retirement<L> {
  const custom = input.env[LAUNCH_AGENTS_ENV]?.trim() ?? "";
  const testing = input.env.CASHU_TESTING === "1";
  const realDefault = custom === "";
  // The real ~/Library/LaunchAgents is touched only by a packaged prod app outside tests, when `home`
  // is the account's own home and the import was into the account's default data dir: a temp HOME, a
  // dev checkout or a demo / synthetic data dir must never boot out the real gui domain's agents.
  const runtime = input.runtime;
  const touchDefault =
    realDefault &&
    !testing &&
    input.testBuild !== true &&
    input.launchctl !== null &&
    runtime?.packaged === true &&
    runtime.flavor.inheritsPythonInstall &&
    isAccountHome(input.home, input.accountHome) &&
    isAccountDefaultDataDir(input.dataDir, input.accountHome, runtime);
  const skipped = (): Retirement<L> => ({
    bootout: "skipped",
    agents: input.labels.map((label) => ({ label, state: "skipped" })),
  });
  if (realDefault && !touchDefault) return skipped();
  if (!realDefault && (!isAbsolute(custom) || resolve(custom) !== custom))
    return {
      bootout: "skipped",
      agents: input.labels.map((label) => ({ label, state: "failed" })),
    };
  const dir = realDefault ? join(input.home, "Library", "LaunchAgents") : custom;
  const launchctl = touchDefault ? input.launchctl : null;
  const agents = input.labels.map((label): AgentOutcome<L> => {
    const plist = join(dir, `${label}.plist`);
    const state = plistState(plist);
    if (state === "absent") return { label, state: "absent" };
    if (state === "unreadable") return { label, state: "failed" };
    let booted = true;
    if (launchctl !== null) {
      let status: number | null;
      try {
        status = launchctl(["/bin/launchctl", "bootout", `gui/${input.uid}/${label}`]);
      } catch {
        status = null;
      }
      booted = status === 0 || (status !== null && NOT_LOADED.has(status));
    }
    // The plist goes even when the bootout failed: nothing loads it at the next login, and the
    // reported failure names the bootout to finish by hand.
    try {
      unlinkSync(plist);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { label, state: "failed" };
    }
    return { label, state: booted ? "retired" : "failed" };
  });
  return { bootout: launchctl === null ? "skipped" : "ran", agents };
}

/** The Python app's two worker agents, retired after a successful import. */
export function retirePythonAgents(input: Omit<RetireInput, "labels">): PythonAgentRetirement {
  return retireLaunchAgents<PythonAgentLabel>({ ...input, labels: PYTHON_AGENT_LABELS });
}
