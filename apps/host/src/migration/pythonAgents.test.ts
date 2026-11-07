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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonAgentRetirementSchema } from "@cashu/host-protocol/startup-failure";
import { FLAVORS } from "@cashu/node-host/flavor";
import { afterEach, describe, expect, it } from "vitest";
import {
  type LaunchctlRunner,
  productionLaunchctl,
  type RetireRuntime,
  retireLaunchAgents,
  retirePythonAgents,
  systemLaunchctl,
} from "./pythonAgents.js";

const WORKER = "io.utopiasoft.cashu.worker";
const LEGACY = "io.github.synszakala.finanse.worker";
const HOST = "io.utopiasoft.cashu.host";
const OTHER = "com.example.synthetic.agent";
const UID = 501;
/** A packaged prod app (the only runtime whose real default agents dir may be touched). */
const RELEASE: RetireRuntime = { packaged: true, flavor: FLAVORS.prod };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A temp root with `home/` (holding the prod flavor's default data dir
 * `home/Library/Application Support/cashU`), another data dir `data/` and `agents/`; the plists of
 * `labels` go to `agents/` or to the temp home's default `Library/LaunchAgents`.
 */
function tempAgents(labels: readonly string[], where: "agents" | "home-default" = "agents") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-agents-test-")));
  roots.push(root);
  const home = join(root, "home");
  const dir = where === "agents" ? join(root, "agents") : join(home, "Library", "LaunchAgents");
  const dataDir = join(home, "Library", "Application Support", FLAVORS.prod.dataDirName.darwin);
  const otherDataDir = join(root, "data");
  for (const path of [dir, home, dataDir, otherDataDir]) mkdirSync(path, { recursive: true });
  for (const label of labels)
    writeFileSync(join(dir, `${label}.plist`), `<plist><!-- synthetic ${label} --></plist>\n`);
  return { root, home, dir, dataDir, otherDataDir };
}

/** True when the temp dir's disk ignores letter case (the default APFS of macOS). */
function caseInsensitive(): boolean {
  const probe = realpathSync(mkdtempSync(join(tmpdir(), "cashu-agents-case-")));
  try {
    return existsSync(probe.toUpperCase());
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
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
      dataDir: t.dataDir,
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
    const result = retirePythonAgents({
      env: {},
      home: t.home,
      dataDir: t.dataDir,
      runtime: RELEASE,
      uid: UID,
      launchctl: runner,
    });
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
      dataDir: t.dataDir,
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
      dataDir: t.dataDir,
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
      dataDir: t.dataDir,
      runtime: RELEASE,
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
      dataDir: t.dataDir,
      runtime: RELEASE,
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
      dataDir: t.dataDir,
      runtime: RELEASE,
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
      const result = retirePythonAgents({
        ...input,
        home: t.home,
        dataDir: t.dataDir,
        runtime: RELEASE,
        accountHome: t.home,
        uid: UID,
      });
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
      dataDir: t.dataDir,
      runtime: RELEASE,
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
      dataDir: custom.dataDir,
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
        dataDir: t.dataDir,
        accountHome: t.home,
        uid: UID,
        launchctl: runner,
      }).agents.map((agent) => agent.state),
    ).toEqual(["failed", "failed"]);
    const result = retirePythonAgents({
      env: { CASHU_LAUNCH_AGENTS_DIR: t.dir },
      home: t.home,
      dataDir: t.dataDir,
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

  it("boots out only after an import into the account's default data dir (fake runner)", () => {
    // Every other real-home condition holds (packaged prod, no CASHU_TESTING, no custom dir, a
    // runner, HOME is the account home): an import anywhere else never reaches the runner.
    const t = tempAgents([WORKER, LEGACY], "home-default");
    const { calls, runner } = recorder();
    const base = { env: {}, home: t.home, accountHome: t.home, uid: UID, launchctl: runner };
    const lookalike = join(t.home, "Library", "Application Support", "cashU-demo");
    mkdirSync(lookalike);
    for (const dataDir of [
      t.otherDataDir,
      lookalike,
      join(t.dataDir, "nested"),
      join(t.home, "Library", "Application Support", FLAVORS.staging.dataDirName.darwin),
    ]) {
      const result = retirePythonAgents({ ...base, dataDir, runtime: RELEASE });
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
    // The default data dir reached through a symlink is the same dir (canonical comparison).
    const link = join(t.root, "link-to-default");
    symlinkSync(t.dataDir, link);
    const retired = retirePythonAgents({ ...base, dataDir: link, runtime: RELEASE });
    expect(retired.bootout).toBe("ran");
    expect(calls).toHaveLength(2);
  });

  it.runIf(caseInsensitive())(
    "compares the data dir canonically on a case-insensitive disk",
    () => {
      const t = tempAgents([WORKER], "home-default");
      const { calls, runner } = recorder();
      const result = retirePythonAgents({
        env: {},
        home: t.home,
        accountHome: t.home,
        dataDir: t.dataDir.replace("Application Support", "application support").toUpperCase(),
        runtime: RELEASE,
        uid: UID,
        launchctl: runner,
      });
      expect(result.bootout).toBe("ran");
      expect(calls).toEqual([["/bin/launchctl", "bootout", `gui/${UID}/${WORKER}`]]);
    },
  );

  it("a source run, staging or a missing runtime never touches the real default dir", () => {
    const t = tempAgents([WORKER, LEGACY], "home-default");
    const { calls, runner } = recorder();
    const base = {
      env: {},
      home: t.home,
      accountHome: t.home,
      dataDir: t.dataDir,
      uid: UID,
      launchctl: runner,
    };
    for (const runtime of [
      undefined,
      { packaged: false, flavor: FLAVORS.prod },
      { packaged: true, flavor: FLAVORS.staging },
    ]) {
      const result = retirePythonAgents(runtime === undefined ? base : { ...base, runtime });
      expect(result.agents.map((agent) => agent.state)).toEqual(["skipped", "skipped"]);
    }
    expect(calls).toEqual([]);
    expect(readdirSync(t.dir).sort()).toEqual([`${LEGACY}.plist`, `${WORKER}.plist`]);
  });

  it("keeps the custom agents dir path for any data dir and runtime (plists only)", () => {
    const t = tempAgents([WORKER, LEGACY, HOST]);
    const { calls, runner } = recorder();
    const result = retirePythonAgents({
      env: { CASHU_LAUNCH_AGENTS_DIR: t.dir },
      home: t.home,
      dataDir: t.otherDataDir,
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
    expect(calls).toEqual([]);
    expect(readdirSync(t.dir)).toEqual([`${HOST}.plist`]);
  });

  it("retires an injected label the same way (the manual proof's path)", () => {
    const label = "cashu-next-test.retire.0123abcd";
    const t = tempAgents([label, WORKER], "home-default");
    const { calls, runner } = recorder();
    const result = retireLaunchAgents({
      env: {},
      home: t.home,
      dataDir: t.dataDir,
      runtime: RELEASE,
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

describe("productionLaunchctl (the runner host main.ts wires for `migrate`)", () => {
  it("is the real runner only for a packaged prod app on macOS that is not a test build", () => {
    const facts = { platform: "darwin" as const, runtime: RELEASE, testBuild: false };
    expect(productionLaunchctl(facts)).toBe(systemLaunchctl);
    // A source run (dev `cashu migrate`, tests, e2e) gets no runner at all.
    expect(
      productionLaunchctl({ ...facts, runtime: { packaged: false, flavor: FLAVORS.prod } }),
    ).toBeNull();
    expect(
      productionLaunchctl({ ...facts, runtime: { packaged: true, flavor: FLAVORS.staging } }),
    ).toBeNull();
    expect(productionLaunchctl({ ...facts, testBuild: true })).toBeNull();
    expect(productionLaunchctl({ ...facts, platform: "linux" })).toBeNull();
  });
});
