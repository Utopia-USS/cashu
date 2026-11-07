// The Python worker agents' retirement on synthetic temp LaunchAgents dirs. launchctl is always a
// recording fake: no test here ever executes /bin/launchctl, and no test touches the real
// ~/Library/LaunchAgents (every `home` is a temp dir, and the env rules keep the default dir closed).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonAgentRetirementSchema } from "@cashu/host-protocol/startup-failure";
import { afterEach, describe, expect, it } from "vitest";
import { type LaunchctlRunner, retireLaunchAgents, retirePythonAgents } from "./pythonAgents.js";

const WORKER = "io.utopiasoft.cashu.worker";
const LEGACY = "io.github.synszakala.finanse.worker";
const HOST = "io.utopiasoft.cashu.host";
const OTHER = "com.example.synthetic.agent";
const UID = 501;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp root with `home/` and `agents/` holding synthetic plists of `labels`. */
function tempAgents(labels: readonly string[], where: "agents" | "home-default" = "agents") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-agents-test-")));
  roots.push(root);
  const home = join(root, "home");
  const dir = where === "agents" ? join(root, "agents") : join(home, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const label of labels)
    writeFileSync(join(dir, `${label}.plist`), `<plist><!-- synthetic ${label} --></plist>\n`);
  return { root, home, dir };
}

function recorder(status: (argv: readonly string[]) => number | null = () => 0) {
  const calls: string[][] = [];
  const runner: LaunchctlRunner = (argv) => {
    calls.push([...argv]);
    return status(argv);
  };
  return { calls, runner };
}

describe("retirePythonAgents", () => {
  it("with a custom agents dir removes exactly the two Python plists and never runs launchctl", () => {
    const t = tempAgents([WORKER, LEGACY, HOST, OTHER]);
    const { calls, runner } = recorder();
    const result = retirePythonAgents({
      env: { CASHU_LAUNCH_AGENTS_DIR: t.dir, CASHU_TESTING: "1" },
      home: t.home,
      accountHome: t.home,
      uid: UID,
      launchctl: runner,
    });
    expect(result).toEqual({
      bootout: "skipped",
      agents: [
        { label: WORKER, state: "retired" },
        { label: LEGACY, state: "retired" },
      ],
    });
    expect(pythonAgentRetirementSchema.parse(result)).toEqual(result);
    expect(calls).toEqual([]);
    expect(readdirSync(t.dir).sort()).toEqual([`${OTHER}.plist`, `${HOST}.plist`].sort());
  });

  it("never boots out or removes anything when HOME is not the account's home", () => {
    const t = tempAgents([WORKER, LEGACY], "home-default");
    const { calls, runner } = recorder();
    // No accountHome: the default is the real account home, which the temp home is not.
    const result = retirePythonAgents({ env: {}, home: t.home, uid: UID, launchctl: runner });
    expect(result.bootout).toBe("skipped");
    expect(result.agents.map((agent) => agent.state)).toEqual(["skipped", "skipped"]);
    expect(calls).toEqual([]);
    expect(readdirSync(t.dir).sort()).toEqual([`${LEGACY}.plist`, `${WORKER}.plist`].sort());
  });

  it("is idempotent: a second run finds both absent", () => {
    const t = tempAgents([WORKER, HOST]);
    const env = { CASHU_LAUNCH_AGENTS_DIR: t.dir };
    const first = retirePythonAgents({
      env,
      home: t.home,
      accountHome: t.home,
      uid: UID,
      launchctl: null,
    });
    expect(first.agents).toEqual([
      { label: WORKER, state: "retired" },
      { label: LEGACY, state: "absent" },
    ]);
    const second = retirePythonAgents({
      env,
      home: t.home,
      accountHome: t.home,
      uid: UID,
      launchctl: null,
    });
    expect(second).toEqual({
      bootout: "skipped",
      agents: [
        { label: WORKER, state: "absent" },
        { label: LEGACY, state: "absent" },
      ],
    });
    expect(readdirSync(t.dir)).toEqual([`${HOST}.plist`]);
  });

  it("boots out by exact argv only in the real default dir outside tests (fake runner, temp home)", () => {
    // `home` is a temp dir, so the "real default" here is <temp>/home/Library/LaunchAgents.
    const t = tempAgents([WORKER, LEGACY, HOST, OTHER], "home-default");
    const { calls, runner } = recorder((argv) => (argv[2]?.endsWith(LEGACY) ? 113 : 0));
    const result = retirePythonAgents({
      env: {},
      home: t.home,
      accountHome: t.home,
      uid: UID,
      launchctl: runner,
    });
    expect(calls).toEqual([
      ["/bin/launchctl", "bootout", `gui/${UID}/${WORKER}`],
      ["/bin/launchctl", "bootout", `gui/${UID}/${LEGACY}`],
    ]);
    expect(result).toEqual({
      bootout: "ran",
      agents: [
        { label: WORKER, state: "retired" },
        { label: LEGACY, state: "retired" },
      ],
    });
    expect(readdirSync(t.dir).sort()).toEqual([`${OTHER}.plist`, `${HOST}.plist`].sort());
  });

  it("calls launchctl only for a present plist", () => {
    const t = tempAgents([LEGACY], "home-default");
    const { calls, runner } = recorder(() => 3);
    const result = retirePythonAgents({
      env: {},
      home: t.home,
      accountHome: t.home,
      uid: UID,
      launchctl: runner,
    });
    expect(calls).toEqual([["/bin/launchctl", "bootout", `gui/${UID}/${LEGACY}`]]);
    expect(result.agents).toEqual([
      { label: WORKER, state: "absent" },
      { label: LEGACY, state: "retired" },
    ]);
  });

  it("reports a failed bootout (plist still removed) and a runner that throws", () => {
    const t = tempAgents([WORKER, LEGACY], "home-default");
    const { calls, runner } = recorder((argv) => {
      if (argv[2]?.endsWith(LEGACY)) throw new Error("spawn failed");
      return 5;
    });
    const result = retirePythonAgents({
      env: {},
      home: t.home,
      accountHome: t.home,
      uid: UID,
      launchctl: runner,
    });
    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      bootout: "ran",
      agents: [
        { label: WORKER, state: "failed" },
        { label: LEGACY, state: "failed" },
      ],
    });
    expect(readdirSync(t.dir)).toEqual([]);
  });

  it("touches nothing under CASHU_TESTING without a custom dir, or without a runner", () => {
    const t = tempAgents([WORKER, LEGACY], "home-default");
    const { calls, runner } = recorder();
    for (const input of [
      { env: { CASHU_TESTING: "1" }, launchctl: runner },
      { env: { CASHU_LAUNCH_AGENTS_DIR: "  ", CASHU_TESTING: "1" }, launchctl: runner },
      { env: {}, launchctl: null },
    ]) {
      const result = retirePythonAgents({ ...input, home: t.home, accountHome: t.home, uid: UID });
      expect(result).toEqual({
        bootout: "skipped",
        agents: [
          { label: WORKER, state: "skipped" },
          { label: LEGACY, state: "skipped" },
        ],
      });
    }
    expect(calls).toEqual([]);
    expect(readdirSync(t.dir).sort()).toEqual([`${LEGACY}.plist`, `${WORKER}.plist`]);
  });

  it("in a test build never runs launchctl and acts only on an explicit agents dir", () => {
    // Even the input that boots out in a release (real default dir outside tests, a runner, the
    // account's home) touches nothing in a test build.
    const t = tempAgents([WORKER, LEGACY], "home-default");
    const { calls, runner } = recorder();
    const skipped = retirePythonAgents({
      env: {},
      home: t.home,
      accountHome: t.home,
      uid: UID,
      launchctl: runner,
      testBuild: true,
    });
    expect(skipped).toEqual({
      bootout: "skipped",
      agents: [
        { label: WORKER, state: "skipped" },
        { label: LEGACY, state: "skipped" },
      ],
    });
    expect(readdirSync(t.dir).sort()).toEqual([`${LEGACY}.plist`, `${WORKER}.plist`]);
    // With an explicit dir (no CASHU_TESTING): only its two Python plists go, still no launchctl.
    const custom = tempAgents([WORKER, LEGACY, HOST]);
    const retired = retirePythonAgents({
      env: { CASHU_LAUNCH_AGENTS_DIR: custom.dir },
      home: custom.home,
      accountHome: custom.home,
      uid: UID,
      launchctl: runner,
      testBuild: true,
    });
    expect(retired).toEqual({
      bootout: "skipped",
      agents: [
        { label: WORKER, state: "retired" },
        { label: LEGACY, state: "retired" },
      ],
    });
    expect(readdirSync(custom.dir)).toEqual([`${HOST}.plist`]);
    expect(calls).toEqual([]);
  });

  it("refuses a relative custom dir and a directory under a plist name", () => {
    const t = tempAgents([]);
    mkdirSync(join(t.dir, `${WORKER}.plist`));
    const { calls, runner } = recorder();
    expect(
      retirePythonAgents({
        env: { CASHU_LAUNCH_AGENTS_DIR: "relative/agents" },
        home: t.home,
        accountHome: t.home,
        uid: UID,
        launchctl: runner,
      }).agents.map((agent) => agent.state),
    ).toEqual(["failed", "failed"]);
    const result = retirePythonAgents({
      env: { CASHU_LAUNCH_AGENTS_DIR: t.dir },
      home: t.home,
      accountHome: t.home,
      uid: UID,
      launchctl: runner,
    });
    expect(result.agents).toEqual([
      { label: WORKER, state: "failed" },
      { label: LEGACY, state: "absent" },
    ]);
    expect(existsSync(join(t.dir, `${WORKER}.plist`))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("retires an injected label the same way (the manual proof's path)", () => {
    const label = "cashu-next-test.retire.0123abcd";
    const t = tempAgents([label, WORKER], "home-default");
    const { calls, runner } = recorder();
    const result = retireLaunchAgents({
      env: {},
      home: t.home,
      accountHome: t.home,
      uid: UID,
      launchctl: runner,
      labels: [label],
    });
    expect(result).toEqual({ bootout: "ran", agents: [{ label, state: "retired" }] });
    expect(calls).toEqual([["/bin/launchctl", "bootout", `gui/${UID}/${label}`]]);
    expect(readdirSync(t.dir)).toEqual([`${WORKER}.plist`]);
  });
});
