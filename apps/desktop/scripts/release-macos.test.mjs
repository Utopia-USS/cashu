import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
  compareVersions,
  expectedAssets,
  formatCommand,
  ghCreateArgs,
  highestVersion,
  IDENTITY,
  parseCliArgs,
  parseVersion,
  publish,
  releaseNotes,
  releaseTargetProblems,
  releaseUrls,
  sanitizedEnv,
} from "./release-macos.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync(join(tmpdir(), "cashu-release-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("argument and environment rules", () => {
  it("takes exactly one mode", () => {
    expect(parseCliArgs(["--check"])).toEqual({
      mode: "check",
      ref: null,
      keepSrc: false,
      notesPath: null,
      fakePackage: null,
    });
    expect(parseCliArgs(["--yes", "--notes", "notes.md"]).notesPath).toBe("notes.md");
    expect(() => parseCliArgs(["--yes", "--notes"])).toThrow(/needs a file/);
    expect(parseCliArgs(["--dry-run", "--ref", "HEAD", "--keep-src"])).toMatchObject({
      mode: "dry-run",
      ref: "HEAD",
      keepSrc: true,
    });
    expect(parseCliArgs(["--check", "--ref=ts-stack"]).ref).toBe("ts-stack");
    expect(() => parseCliArgs([])).toThrow(/exactly one/);
    expect(() => parseCliArgs(["--check", "--yes"])).toThrow(/exactly one/);
    expect(() => parseCliArgs(["--publish"])).toThrow(/unknown option/);
    expect(() => parseCliArgs(["--dry-run", "--ref"])).toThrow(/needs a revision/);
  });

  it("refuses CI, --ref with --yes, and the fake package step outside --dry-run", () => {
    expect(() => parseCliArgs(["--check"], { CI: "true" })).toThrow(/CI/);
    expect(() => parseCliArgs(["--dry-run"], { GITHUB_ACTIONS: "true" })).toThrow(/CI/);
    expect(() => parseCliArgs(["--yes", "--ref", "HEAD"])).toThrow(
      /--yes always releases origin\/main/,
    );
    const fake = { CASHU_RELEASE_FAKE_PACKAGE: "/tmp/fake.mjs" };
    expect(() => parseCliArgs(["--yes"], fake)).toThrow(/refused outside --dry-run/);
    expect(() => parseCliArgs(["--check"], fake)).toThrow(/refused outside --dry-run/);
    expect(parseCliArgs(["--dry-run"], fake).fakePackage).toBe("/tmp/fake.mjs");
  });

  it("refuses CI before anything else when run as a program", () => {
    const result = spawnSync(process.execPath, [join(here, "release-macos.mjs"), "--check"], {
      env: { PATH: process.env.PATH, CI: "1" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refusing to run in CI/);
  });

  it("drops tokens and signing or publishing variables from the build environment", () => {
    const env = sanitizedEnv({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      LANG: "en_US.UTF-8",
      GH_TOKEN: "x",
      GITHUB_TOKEN: "x",
      NODE_AUTH_TOKEN: "x",
      NPM_TOKEN: "x",
      CSC_LINK: "x",
      APPLE_ID: "x",
      APPLE_APP_SPECIFIC_PASSWORD: "x",
      SOME_API_KEY: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      ELECTRON_BUILDER_PUBLISH: "x",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/x", LANG: "en_US.UTF-8" });
  });
});

describe("versions", () => {
  it("parses strict X.Y.Z and compares numerically", () => {
    expect(parseVersion("0.5.0")).toEqual([0, 5, 0]);
    expect(parseVersion("v0.10.2")).toEqual([0, 10, 2]);
    expect(parseVersion("0.5")).toBeNull();
    expect(parseVersion("0.5.0-beta")).toBeNull();
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.4.6", "0.4.6")).toBe(0);
    expect(compareVersions("v0.4.6", "0.5.0")).toBe(-1);
    expect(highestVersion(["v0.4.2", "v0.4.10", "v0.4.6", "nightly", "v1"])).toBe("0.4.10");
    expect(highestVersion([])).toBeNull();
  });

  it("refuses an existing tag or release and versions not above every earlier release", () => {
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
    expect(releaseTargetProblems({ ...clean, remoteTags: ["v0.5.0"] })).toEqual([
      "tag v0.5.0 exists on origin: nothing new to release.",
      "version 0.5.0 is not above the newest v* tag on origin (0.5.0).",
    ]);
    expect(releaseTargetProblems({ ...clean, releaseExists: true })[0]).toMatch(
      /exists already on GitHub/,
    );
    expect(releaseTargetProblems({ ...clean, version: "0.4.6" }).join("\n")).toMatch(
      /not above the retired Python app's last release \(0.4.6\)/,
    );
    expect(releaseTargetProblems({ ...clean, publishedTags: ["v0.5.3"] })).toEqual([
      "version 0.5.0 is not above the newest published release (0.5.3).",
    ]);
    expect(releaseTargetProblems({ ...clean, version: "v0.5.0" })[0]).toMatch(/not X.Y.Z/);
  });
});

describe("assets and commands", () => {
  it("names seven assets with no arm64 in any Intel name", () => {
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
    expect(releaseUrls("0.5.1", "x64")).toEqual({
      releasePageUrl: "https://github.com/Utopia-USS/cashu/releases/tag/v0.5.1",
      downloadUrl:
        "https://github.com/Utopia-USS/cashu/releases/download/v0.5.1/cashU-0.5.1-mac-x64.dmg",
    });
  });

  it("builds the draft command and release notes without version bumps", () => {
    expect(
      ghCreateArgs({ version: "0.5.1", commit: "abc", notesFile: "/n.md", assetPaths: ["/a.zip"] }),
    ).toEqual([
      "release",
      "create",
      "v0.5.1",
      "--repo",
      "Utopia-USS/cashu",
      "--draft",
      "--target",
      "abc",
      "--title",
      "cashU 0.5.1",
      "--notes-file",
      "/n.md",
      "/a.zip",
    ]);
    expect(formatCommand("gh", ["release", "--title", "cashU 0.5.1", "it's"])).toBe(
      "gh release --title 'cashU 0.5.1' 'it'\\''s'",
    );
    expect(
      releaseNotes(["Add a thing", "Bump version to 0.5.1 [skip ci]", "Fix it"], {
        previous: "v0.5.0",
        tag: "v0.5.1",
      }),
    ).toBe(
      "- Add a thing\n- Fix it\n\nFull list: https://github.com/Utopia-USS/cashu/compare/v0.5.0...v0.5.1\n",
    );
    const many = Array.from({ length: 45 }, (_, i) => `Change ${i}`);
    const capped = releaseNotes(many, { previous: null, tag: "v0.5.1" });
    expect(capped.split("\n").filter((line) => line.startsWith("- Change"))).toHaveLength(40);
    expect(capped).toMatch(/and 5 more commits/);
    expect(releaseNotes([], { previous: null, tag: "v0.5.1" })).toBe("- Maintenance release.\n");
  });
});

// --- Stub tools on PATH ----------------------------------------------------------------------------------

/** A recording `gh`: argv lines to STUB_LOG, draft state in STUB_STATE. */
const GH_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(["gh", ...args]) + "\\n");
const statePath = process.env.STUB_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
const save = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
const [a, b] = args;
if (a === "auth" && b === "status") process.exit(process.env.STUB_GH_AUTH === "fail" ? 1 : 0);
if (a === "api") { console.log("true"); process.exit(0); }
if (a === "release" && b === "list") { console.log(process.env.STUB_GH_RELEASES || '[{"tagName":"v0.4.6","isDraft":false}]'); process.exit(0); }
if (a === "release" && b === "view") {
  if (!state) process.exit(1);
  console.log(JSON.stringify({ assets: state.assets.map((name) => ({ name })), isDraft: !state.published, url: "https://example.invalid/r" }));
  process.exit(0);
}
if (a === "release" && b === "create") {
  const files = args.filter((arg, i) => args[i - 1] !== "--notes-file" && fs.existsSync(arg) && /\\.(zip|dmg|yml|xml)$/.test(arg));
  const drop = process.env.STUB_GH_DROP;
  save({ assets: files.map((f) => path.basename(f)).filter((n) => n !== drop), published: false });
  process.exit(0);
}
if (a === "release" && b === "edit") { save({ ...state, published: true }); process.exit(0); }
process.exit(3);
`;

const TOOL_STUBS = {
  security: `printf '  1) 0123456789ABCDEF "%s"\\n     1 valid identities found\\n' "${IDENTITY}"`,
  xcrun: "exit 0",
  codesign: `case " $* " in *" -dv "*) printf 'TeamIdentifier=29W838VKU4\\nAuthority=%s\\n' "${IDENTITY}" >&2;; esac; exit 0`,
  spctl: "printf 'accepted\\nsource=Notarized Developer ID\\n' >&2; exit 0",
  // The fake dmg is a zip: "attaching" extracts it at the mount point.
  hdiutil: `if [ "$1" = attach ]; then
  while [ $# -gt 1 ]; do [ "$1" = -mountpoint ] && mnt="$2"; shift; done
  /usr/bin/ditto -x -k "$1" "$mnt"
elif [ "$1" = detach ]; then
  eval "last=\\\${$#}"; rm -rf "$last"
fi
exit 0`,
  pnpm: "exit 9",
};

function writeStubs(dir, log) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gh"), GH_STUB);
  chmodSync(join(dir, "gh"), 0o755);
  for (const [name, body] of Object.entries(TOOL_STUBS)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '["${name}"]' >> "${log}"\n${body}\n`);
    chmodSync(path, 0o755);
  }
}

const FAKE_PACKAGE = `import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [step, ...rest] = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify(["fake", step, ...rest, process.env.GH_TOKEN ? "TOKEN-LEAKED" : "no-token"]) + "\\n");
if (step === "package") {
  const [arch, out, version] = rest;
  const stage = join(out, ".fake-" + arch);
  const contents = join(stage, "cashU.app", "Contents");
  mkdirSync(contents, { recursive: true });
  writeFileSync(join(contents, "Info.plist"), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>' + version + '</string></dict></plist>');
  const zip = join(out, "cashU-" + version + "-mac-" + arch + ".zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", join(stage, "cashU.app"), zip]);
  copyFileSync(zip, zip.replace(/\\.zip$/, ".dmg"));
  execFileSync("rm", ["-rf", stage]);
} else if (step === "verify") {
  if (!existsSync(join(rest[0], "Contents", "Info.plist"))) process.exit(2);
}
`;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
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

/** A synthetic repo (origin + clone) holding a copy of the release scripts, so the script's root is the clone. */
function fixtureRepo(name) {
  const dir = join(base, name);
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(base, "gitconfig"), "[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", origin);
  const manifest = join(work, "apps", "desktop", "package.json");
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, '{ "name": "@cashu/desktop", "version": "0.4.6" }\n');
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "Python app");
  git(work, "tag", "v0.4.6");
  writeFileSync(join(work, "README.md"), "native\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "Add the native app");
  writeFileSync(manifest, '{ "name": "@cashu/desktop", "version": "0.5.0" }\n');
  git(work, "commit", "-q", "-am", "Bump version to 0.5.0 [skip ci]");
  git(work, "push", "-q", "origin", "main", "--tags");
  const scripts = join(work, "apps", "desktop", "scripts");
  mkdirSync(join(scripts, "release"), { recursive: true });
  copyFileSync(join(here, "release-macos.mjs"), join(scripts, "release-macos.mjs"));
  for (const file of ["latestMac.mjs", "appcast.mjs"])
    copyFileSync(join(here, "release", file), join(scripts, "release", file));
  const stubs = join(dir, "stubs");
  const log = join(dir, "calls.log");
  writeStubs(stubs, log);
  const fake = join(dir, "fake-package.mjs");
  writeFileSync(fake, FAKE_PACKAGE);
  return {
    work,
    origin,
    stubs,
    log,
    fake,
    state: join(dir, "gh-state.json"),
    script: join(scripts, "release-macos.mjs"),
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
    PATH: `${repo.stubs}${delimiter}${process.env.PATH}`,
    STUB_LOG: repo.log,
    STUB_STATE: repo.state,
    ...extraEnv,
  };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  return spawnSync(process.execPath, [repo.script, ...args], {
    cwd: repo.work,
    env,
    encoding: "utf8",
  });
}

describe("publish (--yes) against a recording gh", () => {
  let repo;
  let assetPaths;
  beforeAll(() => {
    repo = fixtureRepo("publish");
    const dir = join(base, "publish", "assets");
    mkdirSync(dir, { recursive: true });
    assetPaths = expectedAssets("0.5.1").map((name) => {
      writeFileSync(join(dir, name), name);
      return join(dir, name);
    });
    writeFileSync(join(dir, "notes.md"), "- Add a thing\n");
  });
  const env = () => ({
    ...process.env,
    PATH: `${repo.stubs}${delimiter}${process.env.PATH}`,
    STUB_LOG: repo.log,
    STUB_STATE: repo.state,
  });

  it("creates a draft with the 7 assets, checks it, then publishes it as latest", () => {
    rmSync(repo.state, { force: true });
    rmSync(repo.log, { force: true });
    const notesFile = join(dirname(assetPaths[0]), "notes.md");
    publish({
      version: "0.5.1",
      commit: "c0ffee",
      notesFile,
      assetPaths,
      env: env(),
      log: () => {},
    });
    const gh = calls(repo.log)
      .filter((call) => call[0] === "gh")
      .map((call) => call.slice(1));
    expect(gh).toEqual([
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
    rmSync(repo.state, { force: true });
    rmSync(repo.log, { force: true });
    const notesFile = join(dirname(assetPaths[0]), "notes.md");
    expect(() =>
      publish({
        version: "0.5.1",
        commit: "c0ffee",
        notesFile,
        assetPaths,
        env: { ...env(), STUB_GH_DROP: "latest-mac.yml" },
        log: () => {},
      }),
    ).toThrow(/fix or delete the draft/);
    expect(calls(repo.log).some((call) => call[1] === "release" && call[2] === "edit")).toBe(false);
  });
});

describe.skipIf(process.platform !== "darwin")(
  "--dry-run end to end with a fake package step",
  () => {
    it("exports, builds, verifies and writes feeds without any GitHub write or token in the build", () => {
      const repo = fixtureRepo("dry-run");
      const result = runScript(repo, ["--dry-run"], {
        CASHU_RELEASE_FAKE_PACKAGE: repo.fake,
        GH_TOKEN: "synthetic-token",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const commit = git(repo.work, "rev-parse", "origin/main");
      const out = join(repo.work, "build", "release", "v0.5.0");
      expect(readdirSync(out).sort()).toEqual(
        [...expectedAssets("0.5.0"), "release-notes.md"].sort(),
      );
      expect(existsSync(join(repo.work, "build", "release", "src-v0.5.0"))).toBe(false);
      expect(readFileSync(join(out, "release-notes.md"), "utf8")).toBe(
        "- Add the native app\n\nFull list: https://github.com/Utopia-USS/cashu/compare/v0.4.6...v0.5.0\n",
      );
      const yml = readFileSync(join(out, "latest-mac.yml"), "utf8");
      expect(yml).toMatch(/^version: '0.5.0'\n/);
      expect(yml).toMatch(/url: 'cashU-0.5.0-mac-x64.zip'/);
      expect(readFileSync(join(out, "appcast-macos-x86_64.xml"), "utf8")).toMatch(
        /cashU-0.5.0-mac-x64.dmg/,
      );
      expect(result.stdout).toMatch(
        new RegExp(
          `gh release create v0\\.5\\.0 --repo Utopia-USS/cashu --draft --target ${commit} --title 'cashU 0\\.5\\.0'`,
        ),
      );
      for (const name of expectedAssets("0.5.0"))
        expect(result.stdout).toMatch(new RegExp(`[0-9a-f]{64}  ${name.replaceAll(".", "\\.")}`));
      const log = calls(repo.log);
      const gh = log.filter((call) => call[0] === "gh").map((call) => call.slice(1, 3).join(" "));
      expect(gh).toEqual([
        "auth status",
        "api repos/Utopia-USS/cashu",
        "release view",
        "release list",
      ]);
      const fake = log.filter((call) => call[0] === "fake");
      expect(fake.filter((call) => call[1] === "package").map((call) => call[2])).toEqual([
        "arm64",
        "x64",
      ]);
      // Each arch: the app from the zip and the app from the dmg.
      expect(fake.filter((call) => call[1] === "verify")).toHaveLength(4);
      expect(fake.every((call) => call.at(-1) === "no-token")).toBe(true);
      expect(log.some((call) => call[0] === "pnpm")).toBe(false);
    });

    it("stops in preflight when the tag already exists on origin", () => {
      const repo = fixtureRepo("tag-exists");
      git(repo.work, "tag", "v0.5.0");
      git(repo.work, "push", "-q", "origin", "v0.5.0");
      git(repo.work, "tag", "-d", "v0.5.0");
      const result = runScript(repo, ["--dry-run"], { CASHU_RELEASE_FAKE_PACKAGE: repo.fake });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/tag v0\.5\.0 exists/);
      expect(existsSync(join(repo.work, "build"))).toBe(false);
    });

    it("dry-runs another ref when gh is not logged in, skipping the GitHub checks", () => {
      const repo = fixtureRepo("ref");
      const result = runScript(repo, ["--check", "--ref", "HEAD~1"], { STUB_GH_AUTH: "fail" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/gh is not logged in/);
      const dry = runScript(repo, ["--dry-run", "--ref", "HEAD"], {
        STUB_GH_AUTH: "fail",
        CASHU_RELEASE_FAKE_PACKAGE: repo.fake,
      });
      expect(dry.status).toBe(0);
      expect(dry.stdout).toMatch(/GitHub checks skipped/);
    });
  },
);
