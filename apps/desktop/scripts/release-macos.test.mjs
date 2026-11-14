import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  artifactNames,
  CI_ENV,
  ciSigning,
  compareVersions,
  expectedAssets,
  IDENTITY,
  isInside,
  NOTES_REQUIRED_ABOVE,
  notesProblem,
  parseCliArgs,
  publish,
  releaseTargetProblems,
  releaseUrls,
  sanitizedEnv,
} from "./release-macos.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync(join(tmpdir(), "cashu-release-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("argument and environment rules", () => {
  it("refuses CI without --ci, --ci outside GitHub Actions, --ref with --yes and the test hook outside --dry-run", () => {
    expect(() => parseCliArgs([])).toThrow(/exactly one/);
    expect(() => parseCliArgs(["--check", "--yes"])).toThrow(/exactly one/);
    expect(() => parseCliArgs(["--check"], { CI: "true" })).toThrow(/refusing to run in CI/);
    expect(() => parseCliArgs(["--ci", "--yes"], { CI: "true" })).toThrow(/only in GitHub Actions/);
    expect(() => parseCliArgs(["--yes", "--ref", "HEAD"])).toThrow(/always releases origin\/main/);
    expect(() => parseCliArgs(["--ci", "--yes", "--unsigned"], { GITHUB_ACTIONS: "true" })).toThrow(
      /only for --ci --dry-run/,
    );
    const fake = { CASHU_RELEASE_FAKE_PACKAGE: "/fake.mjs" };
    expect(() => parseCliArgs(["--yes"], fake)).toThrow(/refused outside --dry-run/);
    expect(parseCliArgs(["--dry-run"], fake).fakePackage).toBe("/fake.mjs");
  });

  it("takes the CI signing inputs by name and only the owner's Developer ID", () => {
    const good = {
      [CI_ENV.keychain]: "/r/cashu-release.keychain-db",
      [CI_ENV.notaryKey]: "/r/AuthKey.p8",
      [CI_ENV.notaryKeyId]: "ABCDE12345",
      [CI_ENV.notaryIssuer]: "01234567-89ab-cdef-0123-456789abcdef",
    };
    expect(ciSigning(good).identity).toBe(IDENTITY);
    expect(() => ciSigning({})).toThrow(
      "--ci needs CASHU_RELEASE_KEYCHAIN, CASHU_NOTARY_KEY_PATH, CASHU_NOTARY_KEY_ID, CASHU_NOTARY_ISSUER",
    );
    expect(() =>
      ciSigning({ ...good, [CI_ENV.identity]: "Developer ID Application: X (ABCDE12345)" }),
    ).toThrow(/must be "Developer ID Application: Utopia/);
  });

  it("drops tokens and signing or publishing variables from the build environment", () => {
    const env = sanitizedEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      GH_TOKEN: "x",
      GITHUB_TOKEN: "x",
      NPM_TOKEN: "x",
      CSC_LINK: "x",
      APPLE_APP_SPECIFIC_PASSWORD: "x",
      SOME_API_KEY: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      ELECTRON_BUILDER_PUBLISH: "x",
      CASHU_NOTARY_KEY_PATH: "/x.p8",
      CASHU_RELEASE_KEYCHAIN: "/x.keychain-db",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
  });

  it("asks for hand-written notes above the commit limit and keeps the export outside the checkout", () => {
    expect(notesProblem({ commitCount: NOTES_REQUIRED_ABOVE, hasNotes: false })).toBeNull();
    expect(notesProblem({ commitCount: 714, hasNotes: true })).toBeNull();
    expect(notesProblem({ commitCount: 714, hasNotes: false })).toMatch(/714 commits.*--notes/);
    expect(isInside("/a/b", "/a/b/build/x")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
  });
});

describe("version and tag checks", () => {
  it("refuses an existing tag or release and versions not above every earlier release", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    const clean = {
      version: "0.5.0",
      localTagExists: false,
      remoteTags: ["v0.4.5", "v0.4.6"],
      releaseExists: false,
      publishedTags: ["v0.4.6"],
    };
    expect(releaseTargetProblems(clean)).toEqual([]);
    expect(releaseTargetProblems({ ...clean, localTagExists: true })).toEqual([
      "tag v0.5.0 exists locally: nothing new to release.",
    ]);
    expect(releaseTargetProblems({ ...clean, remoteTags: ["v0.5.0"] })[0]).toBe(
      "tag v0.5.0 exists on origin: nothing new to release.",
    );
    expect(releaseTargetProblems({ ...clean, releaseExists: true })[0]).toMatch(
      /exists already on GitHub/,
    );
    expect(releaseTargetProblems({ ...clean, version: "0.4.6" }).join("\n")).toMatch(
      /not above the retired Python app's last release \(0.4.6\)/,
    );
    expect(releaseTargetProblems({ ...clean, publishedTags: ["v0.5.3"] })).toEqual([
      "version 0.5.0 is not above the newest published release (0.5.3).",
    ]);
    expect(releaseTargetProblems({ ...clean, version: "0.5.0-beta" })[0]).toMatch(/not X.Y.Z/);
  });

  it("names the seven assets the installed apps' feeds expect, no arm64 in any Intel name", () => {
    expect(expectedAssets("0.5.1")).toEqual([
      "appcast-macos-arm64.xml",
      "appcast-macos-x86_64.xml",
      "cashU-0.5.1-mac-arm64.dmg",
      "cashU-0.5.1-mac-arm64.zip",
      "cashU-0.5.1-mac-x64.dmg",
      "cashU-0.5.1-mac-x64.zip",
      "latest-mac.yml",
    ]);
    const names = artifactNames("0.5.1");
    for (const name of [names.zip.x64, names.dmg.x64, names.appcast.x64])
      expect(name).not.toMatch(/arm64/);
    expect(releaseUrls("0.5.1", "x64").downloadUrl).toBe(
      "https://github.com/Utopia-USS/cashu/releases/download/v0.5.1/cashU-0.5.1-mac-x64.dmg",
    );
  });
});

// --- Stub tools on PATH (all /bin/sh, so a stub call costs a few ms, not a Node start) -------------------

/** Appends `["<name>", ...argv]` as one JSON line to $STUB_LOG (paths here carry no quotes). */
const LOG_ARGS = (name) =>
  `line='["${name}"'; for a in "$@"; do line="$line,\\"$a\\""; done; printf '%s]\\n' "$line" >> "$STUB_LOG"`;

/** A recording `gh`: the draft's asset names in $STUB_STATE, "published" in $STUB_STATE.published. */
const GH_STUB = `${LOG_ARGS("gh")}
case "$1 $2" in
  "auth status") [ "$STUB_GH_AUTH" = fail ] && exit 1; exit 0 ;;
  "api "*) echo true ;;
  "release list") echo '[{"tagName":"v0.4.6","isDraft":false}]' ;;
  "release view")
    [ -f "$STUB_STATE" ] || exit 1
    draft=true; [ -f "$STUB_STATE.published" ] && draft=false
    printf '{"assets":[%s],"isDraft":%s,"url":"https://example.invalid/r"}\\n' "$(cat "$STUB_STATE")" "$draft" ;;
  "release create")
    names=""
    for a in "$@"; do case "$a" in
      *.zip|*.dmg|*.yml|*.xml) n=$(basename "$a"); [ "$n" = "$STUB_GH_DROP" ] || names="$names\${names:+,}{\\"name\\":\\"$n\\"}" ;;
    esac; done
    printf '%s' "$names" > "$STUB_STATE" ;;
  "release edit") : > "$STUB_STATE.published" ;;
  *) exit 3 ;;
esac`;

const TOOL_STUBS = {
  gh: GH_STUB,
  security: `${LOG_ARGS("security")}\nprintf '  1) 0123456789ABCDEF "%s"\\n     1 valid identities found\\n' "${IDENTITY}"`,
  xcrun: `${LOG_ARGS("xcrun")}\nexit 0`,
  codesign: `${LOG_ARGS("codesign")}\ncase " $* " in *" -dv "*) printf 'TeamIdentifier=29W838VKU4\\nAuthority=%s\\n' "${IDENTITY}" >&2;; esac; exit 0`,
  spctl: `${LOG_ARGS("spctl")}\nprintf 'accepted\\nsource=Notarized Developer ID\\n' >&2; exit 0`,
  // The fake dmg is a zip: "attaching" extracts it at the mount point.
  hdiutil: `${LOG_ARGS("hdiutil")}
if [ "$1" = attach ]; then
  while [ $# -gt 1 ]; do [ "$1" = -mountpoint ] && mnt="$2"; shift; done
  /usr/bin/ditto -x -k "$1" "$mnt"
elif [ "$1" = detach ]; then
  eval "last=\\\${$#}"; rm -rf "$last"
fi
exit 0`,
  pnpm: `${LOG_ARGS("pnpm")}\nexit 9`,
};

// Written and run once, shared by every test: macOS scans each newly written executable at its first run
// (tens of ms each), which would otherwise land in whichever test calls the tool first.
const stubs = join(base, "stubs");
mkdirSync(stubs);
for (const [name, body] of Object.entries(TOOL_STUBS)) {
  writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(stubs, name), 0o755);
  spawnSync(join(stubs, name), ["warm-up"], {
    env: { STUB_LOG: "/dev/null", STUB_STATE: "/dev/null" },
  });
}

/** The CASHU_RELEASE_FAKE_PACKAGE hook: a zip/dmg pair per arch, logging whether a token reached it. */
const FAKE_PACKAGE = `import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [step, ...rest] = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify(["fake", step, ...rest, process.env.GH_TOKEN ? "TOKEN-LEAKED" : "no-token"]) + "\\n");
if (step === "package") {
  const [arch, out, version] = rest;
  const stage = join(out, ".fake-" + arch);
  const contents = join(stage, "cashU.app", "Contents");
  mkdirSync(join(contents, "Resources"), { recursive: true });
  if (process.env.FAKE_TEST_BUILD) writeFileSync(join(contents, "Resources", "test-build.json"), "{}");
  writeFileSync(join(contents, "Info.plist"), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.utopiasoft.cashu</string><key>CFBundleShortVersionString</key><string>' + version + '</string></dict></plist>');
  const zip = join(out, "cashU-" + version + "-mac-" + arch + ".zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", join(stage, "cashU.app"), zip]);
  copyFileSync(zip, zip.replace(/\\.zip$/, ".dmg"));
  rmSync(stage, { recursive: true, force: true });
} else if (step === "verify") {
  if (!existsSync(join(rest[0], "Contents", "Info.plist"))) process.exit(2);
}
`;

function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(base, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Built once: a synthetic origin + clean, pushed clone holding a copy of the release scripts (the script's
 * root is the clone): the retired Python app tagged v0.4.6, then the native app bumped to 0.5.0. The remote is
 * relative, so each test copies the template and gets its own repo for a few ms.
 */
function templateRepo() {
  const dir = join(base, "template");
  const work = join(dir, "work");
  writeFileSync(join(base, "gitconfig"), "[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(dir, "init", "-q", "-b", "main", "work");
  git(work, "remote", "add", "origin", "../origin.git");
  const manifest = join(work, "apps", "desktop", "package.json");
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, '{ "name": "@cashu/desktop", "version": "0.4.6" }\n');
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "Python app");
  git(work, "tag", "v0.4.6");
  writeFileSync(manifest, '{ "name": "@cashu/desktop", "version": "0.5.0" }\n');
  writeFileSync(join(work, ".gitignore"), "build/\n");
  const scripts = join(work, "apps", "desktop", "scripts");
  mkdirSync(join(scripts, "release"), { recursive: true });
  for (const file of ["release-macos.mjs", "release-policy.mjs", "flavor.mjs"])
    copyFileSync(join(here, file), join(scripts, file));
  for (const file of ["latestMac.mjs", "appcast.mjs"])
    copyFileSync(join(here, "release", file), join(scripts, "release", file));
  const flavorTable = join(work, "packages", "node-host", "src", "flavor.json");
  mkdirSync(dirname(flavorTable), { recursive: true });
  copyFileSync(join(here, "../../../packages/node-host/src/flavor.json"), flavorTable);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "Add the native app");
  git(work, "push", "-q", "origin", "main", "--tags");
  writeFileSync(join(dir, "fake-package.mjs"), FAKE_PACKAGE);
  return dir;
}

let fixtureCount = 0;
function fixtureRepo(template) {
  const dir = join(base, `repo-${++fixtureCount}`);
  cpSync(template, dir, { recursive: true });
  mkdirSync(join(dir, "tmp"));
  const work = join(dir, "work");
  return {
    work,
    tmp: join(dir, "tmp"),
    log: join(dir, "calls.log"),
    fake: join(dir, "fake-package.mjs"),
    state: join(dir, "gh-state.json"),
    script: join(work, "apps", "desktop", "scripts", "release-macos.mjs"),
  };
}

function calls(log) {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

function runScript(repo, args, extraEnv = {}) {
  const env = {
    ...gitEnv(),
    PATH: `${stubs}${delimiter}${process.env.PATH}`,
    STUB_LOG: repo.log,
    STUB_STATE: repo.state,
    // The owner modes export the source under TMPDIR: a per-fixture dir shows what is left behind.
    TMPDIR: repo.tmp,
  };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  for (const name of Object.values(CI_ENV)) delete env[name];
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [repo.script, ...args], {
    cwd: repo.work,
    env,
    encoding: "utf8",
  });
}

describe("publish (--yes) against a recording gh", () => {
  const log = join(base, "publish-calls.log");
  const state = join(base, "publish-state");
  let assetPaths;
  let notesFile;
  beforeAll(() => {
    const dir = join(base, "publish-assets");
    mkdirSync(dir, { recursive: true });
    assetPaths = expectedAssets("0.5.1").map((name) => {
      writeFileSync(join(dir, name), name);
      return join(dir, name);
    });
    notesFile = join(dir, "notes.md");
    writeFileSync(notesFile, "- Add a thing\n");
  });
  const run = (extraEnv = {}) => {
    for (const path of [log, state, `${state}.published`]) rmSync(path, { force: true });
    publish({
      version: "0.5.1",
      commit: "c0ffee",
      notesFile,
      assetPaths,
      env: {
        ...process.env,
        PATH: `${stubs}${delimiter}${process.env.PATH}`,
        STUB_LOG: log,
        STUB_STATE: state,
        ...extraEnv,
      },
      log: () => {},
    });
  };

  it("creates a draft with the 7 assets, checks it, then publishes it as latest", () => {
    run();
    expect(calls(log).map((call) => call.slice(1))).toEqual([
      [
        "release",
        "create",
        "v0.5.1",
        "--repo",
        "Utopia-USS/cashu",
        "--draft",
        "--target",
        "c0ffee",
        "--title",
        "cashU 0.5.1",
        "--notes-file",
        notesFile,
        ...assetPaths,
      ],
      ["release", "view", "v0.5.1", "--repo", "Utopia-USS/cashu", "--json", "assets,isDraft"],
      ["release", "edit", "v0.5.1", "--repo", "Utopia-USS/cashu", "--draft=false", "--latest"],
      ["release", "view", "v0.5.1", "--repo", "Utopia-USS/cashu", "--json", "isDraft,url"],
    ]);
  });

  it("stops before publishing when the draft lacks an asset", () => {
    expect(() => run({ STUB_GH_DROP: "latest-mac.yml" })).toThrow(/fix or delete the draft/);
    expect(calls(log).some((call) => call[1] === "release" && call[2] === "edit")).toBe(false);
  });
});

// The script itself refuses to run anywhere but macOS (ditto, hdiutil, codesign).
describe.skipIf(process.platform !== "darwin")(
  "the script end to end with a fake package step",
  () => {
    let template;
    beforeAll(() => {
      template = templateRepo();
    });

    it("dry run: builds, verifies and writes feeds without any GitHub write or token in the build", () => {
      const repo = fixtureRepo(template);
      const result = runScript(repo, ["--dry-run"], {
        CASHU_RELEASE_FAKE_PACKAGE: repo.fake,
        GH_TOKEN: "synthetic-token",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const out = join(repo.work, "build", "release", "v0.5.0");
      expect(readdirSync(out).sort()).toEqual(
        [...expectedAssets("0.5.0"), "release-notes.md"].sort(),
      );
      // The source export lived under TMPDIR, outside the checkout, and is gone.
      expect(result.stdout).toMatch(
        /Exporting [0-9a-f]{12} \(git archive\) to .*cashu-release-v0\.5\.0-/,
      );
      expect(readdirSync(repo.tmp)).toEqual([]);
      expect(readFileSync(join(out, "latest-mac.yml"), "utf8")).toMatch(/^version: '0.5.0'\n/);
      expect(result.stdout).toMatch(/not published \(--dry-run\)\. --yes would run:/);
      const log = calls(repo.log);
      expect(
        log.filter((call) => call[0] === "gh").map((call) => call.slice(1, 3).join(" ")),
      ).toEqual(["auth status", "api repos/Utopia-USS/cashu", "release view", "release list"]);
      const fake = log.filter((call) => call[0] === "fake");
      expect(fake.filter((call) => call[1] === "package").map((call) => call[2])).toEqual([
        "arm64",
        "x64",
      ]);
      // Each arch: the app from the zip and the app from the dmg.
      expect(fake.filter((call) => call[1] === "verify")).toHaveLength(4);
      expect(fake.every((call) => call.at(-1) === "no-token")).toBe(true);
    });

    it("stops in preflight when the tag already exists on origin", () => {
      const repo = fixtureRepo(template);
      git(repo.work, "tag", "v0.5.0");
      git(repo.work, "push", "-q", "origin", "v0.5.0");
      git(repo.work, "tag", "-d", "v0.5.0");
      const result = runScript(repo, ["--dry-run"], { CASHU_RELEASE_FAKE_PACKAGE: repo.fake });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/tag v0\.5\.0 exists on origin/);
      expect(existsSync(join(repo.work, "build"))).toBe(false);
    });

    it("refuses an artifact that carries the sealed test-build marker", () => {
      const repo = fixtureRepo(template);
      const result = runScript(repo, ["--dry-run"], {
        CASHU_RELEASE_FAKE_PACKAGE: repo.fake,
        FAKE_TEST_BUILD: "1",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/TEST BUILD: .* a test build can never be released/);
      expect(result.stdout).not.toMatch(/Writing the update feeds/);
    });

    it("CI refuses a dirty checkout and a commit that is not on origin/main", () => {
      const repo = fixtureRepo(template);
      const ci = { GITHUB_ACTIONS: "true", CI: "true", CASHU_RELEASE_FAKE_PACKAGE: repo.fake };
      writeFileSync(join(repo.work, "README.md"), "changed\n");
      const dirty = runScript(repo, ["--ci", "--dry-run", "--unsigned"], ci);
      expect(dirty.status).toBe(1);
      expect(dirty.stderr).toMatch(/the checkout has changes/);
      git(repo.work, "add", "README.md");
      git(repo.work, "commit", "-q", "-m", "Local only");
      const ahead = runScript(repo, ["--ci", "--dry-run", "--unsigned"], ci);
      expect(ahead.status).toBe(1);
      expect(ahead.stderr).toMatch(/is not on origin\/main/);
      expect(existsSync(join(repo.work, "build"))).toBe(false);
    });
  },
);
