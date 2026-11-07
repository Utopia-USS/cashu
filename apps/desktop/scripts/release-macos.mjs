#!/usr/bin/env node
// Release the native cashU.app to GitHub Releases of Utopia-USS/cashu, where every installed app reads its update
// feed (latest-mac.yml, electron-updater) and the retired Python app reads its Sparkle feed
// (appcast-macos-<uname -m>.xml, an informational "download the new app" item).
//
// Owner modes (the owner's Mac; refused in CI):
//   node apps/desktop/scripts/release-macos.mjs --check     preflight only (tools, GitHub, identity, notary, version)
//   node apps/desktop/scripts/release-macos.mjs --dry-run   + build, sign, notarize, verify, feeds; nothing is uploaded
//   node apps/desktop/scripts/release-macos.mjs --yes       + publish (the owner has reviewed the commits)
// CI mode (.github/workflows/release-macos.yml; allowed only with GITHUB_ACTIONS=true):
//   node apps/desktop/scripts/release-macos.mjs --ci --check | --dry-run [--unsigned] | --yes
//
// Options:
//   --ref <rev>     build <rev> instead of origin/main (owner --check / --dry-run only; --yes builds origin/main)
//   --keep-src      keep the source export afterwards (owner modes; removed by default)
//   --notes <file>  the release text verbatim (default: the commit subjects since the previous v* tag, without
//                   version bumps, at most 40, with a compare link). Above 50 commits --yes requires --notes.
//   --ci            build the checked-out tree in place (a clean checkout of a commit on origin/main, dependencies
//                   already installed by the workflow before any signing material existed), sign
//                   from a temporary keychain and notarize with an App Store Connect API key, all named by env:
//                   CASHU_RELEASE_KEYCHAIN (keychain path), CASHU_NOTARY_KEY_PATH (.p8 path), CASHU_NOTARY_KEY_ID,
//                   CASHU_NOTARY_ISSUER, optional CASHU_RELEASE_IDENTITY (must be the Developer ID below);
//                   --yes publishes with GH_TOKEN.
//   --unsigned      (--ci --dry-run only) ad hoc build without signing or notarization: proves the build and the
//                   7-asset layout where no signing secrets exist.
//
// Owner modes build a `git archive` export of the commit (never a worktree or a second checkout) in a fresh
// directory under $TMPDIR, outside the checkout, so Node resolution cannot fall back to this checkout's
// node_modules and hide a dependency the export lacks; this checkout's branch and uncommitted work stay untouched.
// Artifacts land in <checkout>/build/release/v<version>/:
//   cashU-<v>-mac-arm64.zip / .dmg, cashU-<v>-mac-x64.zip / .dmg, latest-mac.yml,
//   appcast-macos-arm64.xml, appcast-macos-x86_64.xml (the 7 release assets; the Python app's Sparkle feed names
//   come from `uname -m`), release-notes.md (the release text).
//
// Owner modes keep the secrets in the login keychain: codesign and `xcrun notarytool --keychain-profile` read
// them themselves. CI mode gets paths and ids only (the workflow owns the keychain and the key file). This script
// reads no secret and passes no token to the build (GH_TOKEN and similar are dropped from its env).
//
// Test only: CASHU_RELEASE_FAKE_PACKAGE=<script> replaces `pnpm install` + package-macos.mjs with
// `node <script> package <arch> <outDir> <version>` and verify-package.mjs with `node <script> verify <app> <arch>`.
// It is refused outside --dry-run.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appcastFileName, informationalAppcast } from "./release/appcast.mjs";
import { fileEntry, latestMacYml } from "./release/latestMac.mjs";
import { assertNoTestBuild, assertReleasableFlavor } from "./release-policy.mjs";

export const REPO = "Utopia-USS/cashu";
export const TEAM_ID = "29W838VKU4";
export const IDENTITY = `Developer ID Application: Utopia Ultimate Software Solutions Sp. z o.o. (${TEAM_ID})`;
export const NOTARY_PROFILE = "cashu-notary";
/** The last release of the retired Python app: every native release must be above it. */
export const LAST_PYTHON_VERSION = "0.4.6";
export const ARCHES = ["arm64", "x64"];
export const TOOLS = [
  "git",
  "gh",
  "xcrun",
  "codesign",
  "spctl",
  "ditto",
  "hdiutil",
  "pnpm",
  "plutil",
  "security",
  "tar",
];
const MANIFEST = "apps/desktop/package.json";
const NOTES_LIMIT = 40;
/** Above this many commits since the previous tag a published release needs a hand-written --notes file. */
export const NOTES_REQUIRED_ABOVE = 50;
/** CI mode inputs, by environment variable (set by .github/workflows/release-macos.yml). */
export const CI_ENV = {
  identity: "CASHU_RELEASE_IDENTITY",
  keychain: "CASHU_RELEASE_KEYCHAIN",
  notaryKey: "CASHU_NOTARY_KEY_PATH",
  notaryKeyId: "CASHU_NOTARY_KEY_ID",
  notaryIssuer: "CASHU_NOTARY_ISSUER",
};
const USAGE =
  "usage: node apps/desktop/scripts/release-macos.mjs --check | --dry-run | --yes [--ref <rev>] [--keep-src] [--notes <file>]\n" +
  "       node apps/desktop/scripts/release-macos.mjs --ci --check | --dry-run [--unsigned] | --yes [--notes <file>]";

// --- Pure parts (unit tested) -----------------------------------------------------------------------------

/** Parse and validate the command line. Throws with a message for every refused combination. */
export function parseCliArgs(argv, env = {}) {
  const ci = argv.includes("--ci");
  if (ci && env.GITHUB_ACTIONS !== "true")
    throw new Error("--ci runs only in GitHub Actions (GITHUB_ACTIONS=true).");
  if (!ci && (env.CI || env.GITHUB_ACTIONS))
    throw new Error(
      "refusing to run in CI without --ci: the owner modes run only on the owner's Mac.",
    );
  const modes = [];
  let ref = null;
  let keepSrc = false;
  let notesPath = null;
  let unsigned = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check" || arg === "--dry-run" || arg === "--yes") modes.push(arg.slice(2));
    else if (arg === "--ci") continue;
    else if (arg === "--unsigned") unsigned = true;
    else if (arg === "--keep-src") keepSrc = true;
    else if (arg === "--notes") {
      notesPath = argv[++i];
      if (!notesPath || notesPath.startsWith("-")) throw new Error("--notes needs a file");
    } else if (arg === "--ref" || arg.startsWith("--ref=")) {
      const value = arg === "--ref" ? argv[++i] : arg.slice("--ref=".length);
      if (!value || value.startsWith("-")) throw new Error("--ref needs a revision");
      ref = value;
    } else throw new Error(`unknown option: ${arg}\n${USAGE}`);
  }
  if (modes.length !== 1)
    throw new Error(`choose exactly one of --check, --dry-run, --yes\n${USAGE}`);
  const mode = modes[0];
  if (ci && ref !== null)
    throw new Error("--ref is not for --ci: CI builds the checked-out commit.");
  if (ci && keepSrc) throw new Error("--keep-src is not for --ci: CI builds in place.");
  if (unsigned && !(ci && mode === "dry-run"))
    throw new Error("--unsigned is only for --ci --dry-run.");
  if (ref !== null && mode === "yes")
    throw new Error("--ref is only for --check / --dry-run: --yes always releases origin/main.");
  const fakePackage = env.CASHU_RELEASE_FAKE_PACKAGE || null;
  if (fakePackage && mode !== "dry-run")
    throw new Error("CASHU_RELEASE_FAKE_PACKAGE is a test hook and is refused outside --dry-run.");
  return { mode, ci, unsigned, ref, keepSrc, notesPath, fakePackage };
}

/**
 * The CI signing inputs from the environment: a temporary keychain and an App Store Connect API key, by path
 * and id (never their contents). Throws naming every missing or malformed variable.
 */
export function ciSigning(env) {
  const missing = [
    CI_ENV.keychain,
    CI_ENV.notaryKey,
    CI_ENV.notaryKeyId,
    CI_ENV.notaryIssuer,
  ].filter((name) => !env[name]);
  if (missing.length)
    throw new Error(
      `--ci needs ${missing.join(", ")} (the release workflow sets them from the release environment).`,
    );
  const identity = env[CI_ENV.identity] || IDENTITY;
  const keychain = env[CI_ENV.keychain];
  const notaryKey = env[CI_ENV.notaryKey];
  const notaryKeyId = env[CI_ENV.notaryKeyId];
  const notaryIssuer = env[CI_ENV.notaryIssuer];
  const problems = [];
  if (identity !== IDENTITY) problems.push(`${CI_ENV.identity} must be "${IDENTITY}"`);
  if (!isAbsolute(keychain) || !/\.keychain(-db)?$/.test(keychain))
    problems.push(`${CI_ENV.keychain} must be an absolute .keychain-db path`);
  if (!isAbsolute(notaryKey) || !notaryKey.endsWith(".p8"))
    problems.push(`${CI_ENV.notaryKey} must be an absolute .p8 path`);
  if (!/^[A-Z0-9]{10}$/.test(notaryKeyId))
    problems.push(`${CI_ENV.notaryKeyId} is not an App Store Connect key id`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notaryIssuer))
    problems.push(`${CI_ENV.notaryIssuer} is not an issuer UUID`);
  if (problems.length) throw new Error(problems.join("; "));
  return { identity, keychain, notaryKey, notaryKeyId, notaryIssuer };
}

/**
 * package-macos.mjs arguments for one arch. `signing` null = ad hoc; with `notaryProfile` the owner's keychain
 * profile notarizes, else the CI API key (`notaryKey`, `notaryKeyId`, `notaryIssuer`) and its `keychain`.
 */
export function packageArgs({ script, arch, dir, signing }) {
  const args = [script, arch];
  if (signing) {
    args.push("--sign", signing.identity);
    if (signing.keychain) args.push("--keychain", signing.keychain);
    if (signing.notaryProfile) args.push("--notarize", signing.notaryProfile);
    else
      args.push(
        "--notary-key",
        signing.notaryKey,
        "--notary-key-id",
        signing.notaryKeyId,
        "--notary-issuer",
        signing.notaryIssuer,
      );
  }
  args.push("--dmg", "--out", dir);
  return args;
}

/** Why the default release text cannot be published, or null. A dry run only warns. */
export function notesProblem({ commitCount, hasNotes }) {
  if (hasNotes || commitCount <= NOTES_REQUIRED_ABOVE) return null;
  return (
    `${commitCount} commits since the previous tag (more than ${NOTES_REQUIRED_ABOVE}): ` +
    "write the release text and pass --notes <file>."
  );
}

/** True when `child` is `parent` or inside it. */
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/** [major, minor, patch] of a strict X.Y.Z version (an optional leading "v"), else null. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`not X.Y.Z versions: ${a}, ${b}`);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

/** The highest X.Y.Z among tags like "v0.4.6" (others are ignored), or null. */
export function highestVersion(tags) {
  let best = null;
  for (const tag of tags) {
    if (!parseVersion(tag)) continue;
    const version = String(tag).trim().replace(/^v/, "");
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/**
 * Every reason the version cannot be released: the tag exists (locally, on origin, or as a GitHub release,
 * draft included) or the version is not above the newest published release, the newest v* tag and 0.4.6.
 */
export function releaseTargetProblems({
  version,
  localTagExists,
  remoteTags,
  releaseExists,
  publishedTags,
}) {
  const problems = [];
  if (!parseVersion(version) || version.startsWith("v"))
    return [`version is not X.Y.Z: ${version}`];
  const tag = `v${version}`;
  if (localTagExists) problems.push(`tag ${tag} exists locally: nothing new to release.`);
  if (remoteTags.includes(tag))
    problems.push(`tag ${tag} exists on origin: nothing new to release.`);
  if (releaseExists) problems.push(`release ${tag} exists already on GitHub (maybe as a draft).`);
  const floors = [
    ["the retired Python app's last release", LAST_PYTHON_VERSION],
    ["the newest published release", highestVersion(publishedTags)],
    ["the newest v* tag on origin", highestVersion(remoteTags)],
  ];
  for (const [label, floor] of floors) {
    if (floor !== null && compareVersions(version, floor) <= 0)
      problems.push(`version ${version} is not above ${label} (${floor}).`);
  }
  return problems;
}

/** File names of the release, keyed by role. The x64 names never contain "arm64" (MacUpdater selection). */
export function artifactNames(version) {
  const name = (arch, ext) => `cashU-${version}-mac-${arch}.${ext}`;
  return {
    zip: { arm64: name("arm64", "zip"), x64: name("x64", "zip") },
    dmg: { arm64: name("arm64", "dmg"), x64: name("x64", "dmg") },
    // The retired Python app builds its feed name from `uname -m`: x86_64 on Intel Macs (release/appcast.mjs).
    appcast: { arm64: appcastFileName("arm64"), x64: appcastFileName("x64") },
    latest: "latest-mac.yml",
  };
}

/** The 7 assets every release carries, sorted. */
export function expectedAssets(version) {
  const names = artifactNames(version);
  return [
    ...Object.values(names.zip),
    ...Object.values(names.dmg),
    ...Object.values(names.appcast),
    names.latest,
  ].sort();
}

export function releaseUrls(version, arch) {
  const tag = `v${version}`;
  return {
    releasePageUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
    downloadUrl: `https://github.com/${REPO}/releases/download/${tag}/${artifactNames(version).dmg[arch]}`,
  };
}

/** Release text: commit subjects (newest first, version bumps already dropped), capped, with a compare link. */
export function releaseNotes(subjects, { previous, tag }) {
  const lines = subjects.filter((line) => line.trim() !== "" && !/^Bump version to /.test(line));
  const shown = lines.slice(0, NOTES_LIMIT).map((line) => `- ${line}`);
  if (lines.length > NOTES_LIMIT)
    shown.push(`- ... and ${lines.length - NOTES_LIMIT} more commits`);
  if (shown.length === 0) shown.push("- Maintenance release.");
  if (previous)
    shown.push("", `Full list: https://github.com/${REPO}/compare/${previous}...${tag}`);
  return `${shown.join("\n")}\n`;
}

const SECRET_KEY_RE =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH|AUTHTOKEN|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIALS?)($|_)/i;
const SECRET_PREFIX_RE =
  /^(GH_|GITHUB_|CSC_|APPLE_|NOTARIZE_|SPARKLE_|ELECTRON_BUILDER_PUBLISH|NPM_CONFIG__|CASHU_NOTARY_|CASHU_RELEASE_)/i;

/** The environment for child builds: no tokens, no signing or publishing variables. */
export function sanitizedEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !SECRET_KEY_RE.test(key) && !SECRET_PREFIX_RE.test(key)),
  );
}

export function ghCreateArgs({ version, commit, notesFile, assetPaths }) {
  return [
    "release",
    "create",
    `v${version}`,
    "--repo",
    REPO,
    "--draft",
    "--target",
    commit,
    "--title",
    `cashU ${version}`,
    "--notes-file",
    notesFile,
    ...assetPaths,
  ];
}

export function ghPublishArgs(version) {
  return ["release", "edit", `v${version}`, "--repo", REPO, "--draft=false", "--latest"];
}

/** A shell-ready rendering of a command, for printing only. */
export function formatCommand(program, args) {
  const quote = (value) =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  return [program, ...args].map(quote).join(" ");
}

// --- Effects ------------------------------------------------------------------------------------------------

function say(text) {
  process.stdout.write(`\n==> ${text}\n`);
}
function ok(text) {
  process.stdout.write(`    ok  ${text}\n`);
}
function note(text) {
  process.stdout.write(`    ..  ${text}\n`);
}

/** spawnSync with captured output; throws unless `allowFail`. */
function run(
  program,
  args,
  { cwd, env = process.env, allowFail = false, inherit = false, timeout } = {},
) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  const out = { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  if (result.error && !allowFail)
    throw new Error(`${program} ${args[0] ?? ""}: ${result.error.message}`);
  if (out.status !== 0 && !allowFail) {
    const detail = `${out.stderr}${out.stdout}`.trim().split("\n").slice(-15).join("\n");
    throw new Error(
      `${formatCommand(program, args)} failed (${out.status ?? "signal"})${detail ? `\n${detail}` : ""}`,
    );
  }
  return out;
}

function onPath(tool, env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, tool), constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

/**
 * Draft, check, publish. The draft is checked to carry exactly the expected assets before it is published (a
 * published release is immutable); a mismatch stops with the draft left for the owner to fix or delete.
 * `gh` comes from PATH (tests put a recording stub there).
 */
export function publish({ version, commit, notesFile, assetPaths, env = process.env, log = ok }) {
  const tag = `v${version}`;
  run("gh", ghCreateArgs({ version, commit, notesFile, assetPaths }), { env });
  log(`draft ${tag} created`);
  const view = JSON.parse(
    run("gh", ["release", "view", tag, "--repo", REPO, "--json", "assets,isDraft"], { env }).stdout,
  );
  const names = (view.assets ?? []).map((asset) => asset.name).sort();
  const expected = expectedAssets(version);
  if (view.isDraft !== true || JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error(
      `the draft ${tag} has [${names.join(" ")}] (draft: ${view.isDraft}), expected [${expected.join(" ")}]: ` +
        "fix or delete the draft on GitHub, nothing was published.",
    );
  log(`draft carries the ${expected.length} expected assets`);
  run("gh", ghPublishArgs(version), { env });
  const after = JSON.parse(
    run("gh", ["release", "view", tag, "--repo", REPO, "--json", "isDraft,url"], { env }).stdout,
  );
  if (after.isDraft !== false) throw new Error(`release ${tag} is still a draft after publishing.`);
  log(`published: ${after.url ?? `https://github.com/${REPO}/releases/tag/${tag}`}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function preflight({ root, options, signing, env }) {
  const { mode, ref, ci } = options;
  say("Preflight");
  if (process.platform !== "darwin") throw new Error("releases are built on macOS.");
  const missing = TOOLS.filter((tool) => !onPath(tool, env));
  if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);
  ok(`tools: ${TOOLS.join(" ")}`);
  const git = (...args) => run("git", args, { cwd: root, env }).stdout.trim();

  const ghReady = run("gh", ["auth", "status"], { env, allowFail: true }).status === 0;
  if (!ghReady && mode !== "dry-run")
    throw new Error(ci ? "gh has no GH_TOKEN in CI." : "gh is not logged in (gh auth login).");
  if (ghReady && !ci) {
    const admin = run("gh", ["api", `repos/${REPO}`, "--jq", ".permissions.admin"], {
      env,
    }).stdout.trim();
    if (admin !== "true")
      throw new Error(
        `your GitHub account is not an admin of ${REPO}: only admins may create release tags.`,
      );
    ok(`GitHub: admin of ${REPO}`);
  } else if (ghReady) ok("GitHub: GH_TOKEN of this workflow run");
  else note("gh is not logged in: GitHub checks skipped (allowed in --dry-run only)");

  if (signing === null) note("--unsigned: no signing identity or notarization (ad hoc build)");
  else {
    const identities = run(
      "security",
      ["find-identity", "-v", "-p", "codesigning", ...(signing.keychain ? [signing.keychain] : [])],
      { env },
    ).stdout;
    if (!identities.includes(`"${signing.identity}"`))
      throw new Error(
        `no valid signing identity "${signing.identity}" in ${signing.keychain ?? "the keychain"}.`,
      );
    ok(`signing identity: ${signing.identity}${signing.keychain ? " (temporary keychain)" : ""}`);
    if (signing.notaryProfile) {
      const notary = run(
        "xcrun",
        ["notarytool", "history", "--keychain-profile", signing.notaryProfile],
        { env, allowFail: true, timeout: 120_000 },
      );
      if (notary.status !== 0)
        throw new Error(`notarytool keychain profile "${signing.notaryProfile}" does not work.`);
      ok(`notarization profile: ${signing.notaryProfile}`);
    } else {
      if (!existsSync(signing.keychain)) throw new Error(`no keychain at ${signing.keychain}`);
      if (!existsSync(signing.notaryKey)) throw new Error("the notary API key file is missing");
      const notary = run(
        "xcrun",
        [
          "notarytool",
          "history",
          "--key",
          signing.notaryKey,
          "--key-id",
          signing.notaryKeyId,
          "--issuer",
          signing.notaryIssuer,
        ],
        { env, allowFail: true, timeout: 120_000 },
      );
      if (notary.status !== 0)
        throw new Error(`notarytool refuses the App Store Connect API key ${signing.notaryKeyId}.`);
      ok(`notarization: App Store Connect API key ${signing.notaryKeyId}`);
    }
  }

  git("fetch", "--quiet", "--tags", "origin");
  let commit;
  if (ci) {
    // CI builds the checked-out tree itself: it must be clean and on origin/main.
    const dirty = git("status", "--porcelain");
    if (dirty)
      throw new Error(`the checkout has changes, CI releases only a clean commit:\n${dirty}`);
    commit = git("rev-parse", "HEAD");
    const onMain =
      run("git", ["merge-base", "--is-ancestor", commit, "origin/main"], {
        cwd: root,
        env,
        allowFail: true,
      }).status === 0;
    if (!onMain) throw new Error(`${commit.slice(0, 12)} is not on origin/main.`);
  } else
    commit =
      ref === null
        ? git("rev-parse", "origin/main")
        : git("rev-parse", "--verify", `${ref}^{commit}`);
  const source = ci ? "the checkout" : (ref ?? "origin/main");
  const shown = run("git", ["show", `${commit}:${MANIFEST}`], { cwd: root, env, allowFail: true });
  if (shown.status !== 0)
    throw new Error(
      `${commit.slice(0, 12)} (${source}) has no ${MANIFEST}: not the native app (still the retired Python app?).`,
    );
  const manifest = JSON.parse(shown.stdout);
  const version = manifest.version;
  if (!parseVersion(version) || String(version).startsWith("v"))
    throw new Error(`${MANIFEST} at ${commit.slice(0, 12)} has no X.Y.Z version: ${version}`);
  const tag = `v${version}`;
  const localTagExists =
    run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
      cwd: root,
      env,
      allowFail: true,
    }).status === 0;
  const remoteTags = git("ls-remote", "--tags", "--refs", "origin", "refs/tags/v*")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1].replace("refs/tags/", ""));
  let releaseExists = false;
  let publishedTags = [];
  if (ghReady) {
    releaseExists =
      run("gh", ["release", "view", tag, "--repo", REPO, "--json", "tagName"], {
        env,
        allowFail: true,
      }).status === 0;
    publishedTags = JSON.parse(
      run(
        "gh",
        ["release", "list", "--repo", REPO, "--limit", "200", "--json", "tagName,isDraft"],
        { env },
      ).stdout,
    )
      .filter((release) => !release.isDraft)
      .map((release) => release.tagName);
  }
  const problems = releaseTargetProblems({
    version,
    localTagExists,
    remoteTags,
    releaseExists,
    publishedTags,
  });
  if (problems.length) throw new Error(problems.join("\n       "));
  const newest = highestVersion([...publishedTags, ...remoteTags, LAST_PYTHON_VERSION]);
  const describe = run("git", ["describe", "--tags", "--abbrev=0", "--match", "v*", commit], {
    cwd: root,
    env,
    allowFail: true,
  });
  const previous = describe.status === 0 ? describe.stdout.trim() : null;
  ok(
    `release ${tag} from ${source} ${commit.slice(0, 12)}` +
      ` (newest so far: ${newest}${previous ? `, previous tag on this line: ${previous}` : ""})`,
  );
  const range = previous ? [`${previous}..${commit}`] : ["-15", commit];
  const subjects = run(
    "git",
    ["log", "--no-merges", "--invert-grep", "--grep=^Bump version to ", "--format=%s", ...range],
    { cwd: root, env },
  )
    .stdout.split("\n")
    .filter(Boolean);
  say(`What ships in ${tag}`);
  if (!previous) note("first release: the last 15 commits");
  for (const line of subjects.slice(0, NOTES_LIMIT)) process.stdout.write(`    ${line}\n`);
  if (subjects.length > NOTES_LIMIT) note(`... and ${subjects.length - NOTES_LIMIT} more commits`);
  const notesIssue = notesProblem({
    commitCount: subjects.length,
    hasNotes: options.notesPath !== null,
  });
  if (notesIssue && mode === "yes") throw new Error(notesIssue);
  if (notesIssue) note(`WARNING: --yes would stop here: ${notesIssue}`);
  return {
    commit,
    version,
    tag,
    previous,
    notes: releaseNotes(subjects, { previous, tag }),
    ghReady,
  };
}

function verifyApp(app, { arch, version, verifyPackage, signed, env, label }) {
  if (!existsSync(join(app, "Contents", "Info.plist")))
    throw new Error(`${label}: no app at ${app}`);
  // A sealed test build (package-macos.mjs --test-build) is never released, signed or not, and
  // neither is any flavor but prod (the owner's local "cashU Staging").
  assertNoTestBuild(app);
  assertReleasableFlavor(app);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { env });
  const shortVersion = run(
    "plutil",
    ["-extract", "CFBundleShortVersionString", "raw", join(app, "Contents", "Info.plist")],
    { env },
  ).stdout.trim();
  if (shortVersion !== version)
    throw new Error(`${label}: CFBundleShortVersionString ${shortVersion} != ${version}`);
  if (signed) {
    const details = run("codesign", ["-dv", "--verbose=4", app], { env });
    const signature = `${details.stdout}${details.stderr}`;
    if (!signature.split("\n").includes(`TeamIdentifier=${TEAM_ID}`))
      throw new Error(`${label}: not signed by team ${TEAM_ID}`);
    if (!signature.split("\n").includes(`Authority=${IDENTITY}`))
      throw new Error(`${label}: not signed by "${IDENTITY}"`);
    const gatekeeper = run("spctl", ["-a", "-vv", "-t", "execute", app], { env });
    if (!`${gatekeeper.stdout}${gatekeeper.stderr}`.includes("source=Notarized Developer ID"))
      throw new Error(`${label}: Gatekeeper does not see a notarized Developer ID app`);
    run("xcrun", ["stapler", "validate", app], { env });
  }
  run(process.execPath, verifyPackage(app, arch), { env });
  ok(
    signed
      ? `${label}: signature, team ${TEAM_ID}, Gatekeeper (notarized), stapled, version ${version}, package checks`
      : `${label}: ad hoc signature, version ${version}, package checks (UNSIGNED: not releasable)`,
  );
}

function verifyArch({ dir, arch, version, verifyPackage, signed, env }) {
  const names = artifactNames(version);
  const zip = join(dir, names.zip[arch]);
  const dmg = join(dir, names.dmg[arch]);
  const scratch = join(dir, `.verify-${arch}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    const unzipped = join(scratch, "zip");
    run("ditto", ["-x", "-k", zip, unzipped], { env });
    const top = readdirSync(unzipped).filter((name) => name !== "__MACOSX");
    if (top.length !== 1 || top[0] !== "cashU.app")
      throw new Error(`${names.zip[arch]} must hold exactly cashU.app, found [${top.join(", ")}]`);
    verifyApp(join(unzipped, "cashU.app"), {
      arch,
      version,
      verifyPackage,
      signed,
      env,
      label: names.zip[arch],
    });

    if (signed) {
      run("xcrun", ["stapler", "validate", dmg], { env });
      run("codesign", ["--verify", "--verbose=2", dmg], { env });
      const dmgDetails = run("codesign", ["-dv", "--verbose=4", dmg], { env });
      if (
        !`${dmgDetails.stdout}${dmgDetails.stderr}`
          .split("\n")
          .includes(`TeamIdentifier=${TEAM_ID}`)
      )
        throw new Error(`${names.dmg[arch]}: not signed by team ${TEAM_ID}`);
      const dmgGatekeeper = run(
        "spctl",
        ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", dmg],
        { env },
      );
      if (
        !`${dmgGatekeeper.stdout}${dmgGatekeeper.stderr}`.includes("source=Notarized Developer ID")
      )
        throw new Error(
          `${names.dmg[arch]}: Gatekeeper does not see a notarized Developer ID disk image`,
        );
    }
    const mount = join(scratch, "mnt");
    mkdirSync(mount);
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, dmg], {
      env,
    });
    try {
      verifyApp(join(mount, "cashU.app"), {
        arch,
        version,
        verifyPackage,
        signed,
        env,
        label: `${names.dmg[arch]} app`,
      });
    } finally {
      if (run("hdiutil", ["detach", mount], { env, allowFail: true }).status !== 0)
        run("hdiutil", ["detach", "-force", mount], { env, allowFail: true });
    }
    ok(
      signed
        ? `${names.dmg[arch]}: signed by team ${TEAM_ID}, notarized, stapled`
        : `${names.dmg[arch]}: holds the app (UNSIGNED)`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A fresh `git archive` export of `commit` under $TMPDIR, outside the checkout. Returns its paths. */
function exportSource({ root, commit, tag, env }) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), `cashu-release-${tag}-`)));
  if (isInside(root, parent))
    throw new Error(`the source export ${parent} must be outside the checkout ${root} (TMPDIR?)`);
  const src = join(parent, "src");
  mkdirSync(src);
  say(`Exporting ${commit.slice(0, 12)} (git archive) to ${src}`);
  const tarball = join(parent, "src.tar");
  run("git", ["archive", "--format=tar", "-o", tarball, commit], { cwd: root, env });
  run("tar", ["-x", "-f", tarball, "-C", src], { env });
  rmSync(tarball, { force: true });
  return { parent, src };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseCliArgs(argv, env);
  // Read before the long build, so a wrong path, an empty file or a missing CI input stops at once.
  const customNotes = options.notesPath ? readFileSync(resolve(options.notesPath), "utf8") : null;
  if (customNotes !== null && customNotes.trim() === "")
    throw new Error(`${options.notesPath} is empty`);
  const signing = options.unsigned
    ? null
    : options.ci
      ? ciSigning(env)
      : { identity: IDENTITY, notaryProfile: NOTARY_PROFILE };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const target = preflight({ root, options, signing, env });
  const { commit, version, tag } = target;
  if (options.mode === "check") {
    say("Preflight passed (nothing built).");
    return;
  }

  const dir = join(root, "build", "release", tag);
  const buildEnv = sanitizedEnv(env);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let exported = null;
  try {
    let src = root;
    if (options.ci) say(`Building the checkout in place (${commit.slice(0, 12)})`);
    else {
      exported = exportSource({ root, commit, tag, env });
      src = exported.src;
    }

    let verifyPackage;
    if (options.fakePackage) {
      note(`TEST: fake package step ${options.fakePackage}`);
      for (const arch of ARCHES)
        run(process.execPath, [options.fakePackage, "package", arch, dir, version], {
          cwd: src,
          env: buildEnv,
          inherit: true,
        });
      verifyPackage = (app, arch) => [options.fakePackage, "verify", app, arch];
    } else {
      if (options.ci) {
        // The workflow installs before any signing material exists on the runner (dependency install
        // scripts never run next to the keychain); here only check that it happened.
        if (!existsSync(join(src, "node_modules", ".modules.yaml")))
          throw new Error(
            "--ci expects `pnpm install --frozen-lockfile` to have run in the checkout.",
          );
        ok("dependencies installed by the workflow");
      } else {
        say("Installing dependencies (pnpm install --frozen-lockfile)");
        run("pnpm", ["install", "--frozen-lockfile"], { cwd: src, env: buildEnv, inherit: true });
      }
      const packageScript = join(src, "apps/desktop/scripts/package-macos.mjs");
      for (const arch of ARCHES) {
        say(
          `Building ${arch} (${signing ? "Developer ID, notarized, stapled" : "UNSIGNED, ad hoc"})`,
        );
        run(process.execPath, packageArgs({ script: packageScript, arch, dir, signing }), {
          cwd: src,
          env: buildEnv,
          inherit: true,
        });
      }
      // The build's own checks, in release mode: pinned policy and sealed feed, per-arch Mach-O files,
      // Gatekeeper's notarized Developer ID verdict.
      const script = join(src, "apps/desktop/scripts/verify-package.mjs");
      verifyPackage = (app, arch) =>
        signing ? [script, app, arch, "--release", "--notarized"] : [script, app, arch];
    }
    const names = artifactNames(version);
    for (const arch of ARCHES)
      for (const name of [names.zip[arch], names.dmg[arch]])
        if (!existsSync(join(dir, name))) throw new Error(`the build did not produce ${name}`);

    say("Verifying every artifact independently");
    for (const arch of ARCHES)
      verifyArch({ dir, arch, version, verifyPackage, signed: signing !== null, env: buildEnv });

    say("Writing the update feeds");
    const releaseDate = new Date();
    const yml = latestMacYml({
      version,
      arm64: await fileEntry(join(dir, names.zip.arm64)),
      x64: await fileEntry(join(dir, names.zip.x64)),
      releaseDate,
    });
    writeFileSync(join(dir, names.latest), yml);
    ok(names.latest);
    for (const arch of ARCHES) {
      const xml = informationalAppcast({
        arch,
        version,
        ...releaseUrls(version, arch),
        pubDate: releaseDate,
      });
      writeFileSync(join(dir, names.appcast[arch]), xml);
      ok(names.appcast[arch]);
    }
    const notesFile = join(dir, "release-notes.md");
    writeFileSync(notesFile, customNotes ?? target.notes);

    const assets = expectedAssets(version);
    const present = readdirSync(dir)
      .filter((name) => assets.includes(name))
      .sort();
    if (JSON.stringify(present) !== JSON.stringify(assets))
      throw new Error(`artifacts [${present.join(" ")}] differ from [${assets.join(" ")}]`);
    say("sha256");
    for (const name of assets) process.stdout.write(`    ${sha256(join(dir, name))}  ${name}\n`);
    const assetPaths = assets.map((name) => join(dir, name));

    if (options.mode === "dry-run") {
      say(
        `Built and verified${signing ? "" : " (UNSIGNED)"}, not published (--dry-run). ${options.ci ? "--ci --yes" : "--yes"} would run:`,
      );
      process.stdout.write(
        `    ${formatCommand("gh", ghCreateArgs({ version, commit, notesFile, assetPaths }))}\n`,
      );
      process.stdout.write(
        `    gh release view ${tag} --repo ${REPO} --json assets,isDraft   # expect the 7 assets\n`,
      );
      process.stdout.write(`    ${formatCommand("gh", ghPublishArgs(version))}\n`);
      process.stdout.write(`    artifacts: ${dir}\n`);
      return;
    }

    say(`Publishing ${tag}`);
    if (options.ci) {
      // main may move on during the build (the next merge); the release commit must stay on it.
      run("git", ["fetch", "--quiet", "origin", "main"], { cwd: root, env });
      const stillOnMain =
        run("git", ["merge-base", "--is-ancestor", commit, "FETCH_HEAD"], {
          cwd: root,
          env,
          allowFail: true,
        }).status === 0;
      if (!stillOnMain) throw new Error(`${commit.slice(0, 12)} is no longer on origin/main.`);
    } else {
      const remoteMain = run("git", ["ls-remote", "origin", "refs/heads/main"], {
        cwd: root,
        env,
      }).stdout.split("\t")[0];
      if (remoteMain !== commit)
        throw new Error(
          `origin/main moved to ${remoteMain.slice(0, 12)} during the build: run again.`,
        );
    }
    publish({ version, commit, notesFile, assetPaths, env });
    note('installed apps find it at their next check, or at once with "Check for updates".');
  } finally {
    if (exported && options.keepSrc) note(`source export kept: ${exported.parent}`);
    else if (exported) rmSync(exported.parent, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
