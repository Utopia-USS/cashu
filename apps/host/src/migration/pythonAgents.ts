// After a successful `cashu migrate`: retire the launchd worker agents the Python app installed
// (`io.utopiasoft.cashu.worker`, legacy `io.github.synszakala.finanse.worker`; ab24ab6
// `core/worker/scheduler.py`). Once the native bundle replaced the Python one they would call the
// native executable every day (`Contents/MacOS/cashu` and `cashU` are one file on a case-insensitive
// disk). For each of exactly these labels whose `<agents dir>/<label>.plist` exists: `launchctl bootout
// gui/<uid>/<label>` (a "not loaded" answer is fine), then the plist is removed. Idempotent; never a
// glob, never another label (the native host agent `io.utopiasoft.cashu.host` is never touched).
//
// Safety: launchctl runs only through the injected runner, and only when the agents dir is the real
// default (`CASHU_LAUNCH_AGENTS_DIR` unset), `CASHU_TESTING` is not "1" and the home is the account's own. With
// `CASHU_LAUNCH_AGENTS_DIR` set only the plists in that dir are removed (bootout skipped). Without a
// runner, or under tests without that dir, nothing is touched at all (`skipped`).
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  PYTHON_AGENT_LABELS,
  type PythonAgentLabel,
  type PythonAgentRetirement,
} from "@cashu/host-protocol/startup-failure";

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

/**
 * launchctl's answers to a bootout of a service that is not loaded: ESRCH (3, "No such process") and
 * 113 ("Could not find specified service"); both mean there is nothing left to stop.
 */
const NOT_LOADED = new Set([3, 113]);

export interface RetireInput<L extends string = string> {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home (the default agents dir is `<home>/Library/LaunchAgents`). */
  readonly home: string;
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

/** True when `home` is the account's home from the user database (not a HOME override). */
function isAccountHome(home: string, accountHome: string | undefined): boolean {
  try {
    return realpathSync(home) === realpathSync(accountHome ?? userInfo().homedir);
  } catch {
    return false;
  }
}

/** Retires the given launchd agents; never throws (a failure is a `failed` outcome). */
export function retireLaunchAgents<L extends string>(input: RetireInput<L>): Retirement<L> {
  const custom = input.env[LAUNCH_AGENTS_ENV]?.trim() ?? "";
  const testing = input.env.CASHU_TESTING === "1";
  const realDefault = custom === "";
  // The real ~/Library/LaunchAgents is touched only by the production wiring outside tests, and only
  // when `home` is the account's own home: a temp HOME must never boot out the real gui domain's agents.
  const touchDefault =
    realDefault &&
    !testing &&
    input.launchctl !== null &&
    isAccountHome(input.home, input.accountHome);
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
