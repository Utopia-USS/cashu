// The release policy the packaging scripts seal into a build. The single source of truth is
// src/update/releasePolicy.ts (compiled into main.js, read by the update authority); this module
// parses that file instead of repeating the team ID or the feed URL, so the sealed
// Contents/Resources/app-update.yml and the compiled gate can never disagree. A later test-only
// update build substitutes the policy at this one seam; verify-package --release refuses any app
// whose sealed feed or compiled constants differ from the policy in releasePolicy.ts.
//
// The test-build seam: package-macos.mjs --test-build <json> seals Contents/Resources/test-build.json
// (listed in bundle-manifest.json) and an app-update.yml naming a local http://127.0.0.1:<port>/ feed.
// The app honors it only from a verified bundle (packages/node-host/src/testBuild.ts, same rules as
// parseTestBuild below). assertNoTestBuild refuses such a bundle for every release path.
//
// Only the prod flavor is ever released (scripts/flavor.mjs, packages/node-host/src/flavor.json):
// assertReleasableFlavor refuses any other bundle (the staging app) on every release path.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { FLAVOR_IDS, flavorByBundleId, flavorById } from "./flavor.mjs";

/** The released app's bundle ID: the prod flavor's, the only one with an update feed. */
export const APP_ID = flavorById("prod").bundleId;
/** electron-updater's download cache: ~/Library/Caches/<name>. Fixed so updates never collide. */
export const UPDATER_CACHE_DIR_NAME = "cashu-updater";

function constant(source, name) {
  const pattern = new RegExp(
    `^export const ${name}: string \\| null =\\s*(null|"([^"\\\\\\n]*)");$`,
    "gm",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`releasePolicy.ts: expected one ${name}`);
  return matches[0][1] === "null" ? null : matches[0][2];
}

/** Reads { teamId, feedUrl } from apps/desktop/src/update/releasePolicy.ts; null when unset. */
export function readReleasePolicy(root) {
  const source = readFileSync(join(root, "apps/desktop/src/update/releasePolicy.ts"), "utf8");
  const teamId = constant(source, "RELEASE_TEAM_ID");
  const feedUrl = constant(source, "RELEASE_FEED_URL");
  if (teamId !== null && !/^[A-Z0-9]{10}$/.test(teamId))
    throw new Error("releasePolicy.ts: RELEASE_TEAM_ID is not a team ID");
  if (feedUrl !== null) {
    const url = new URL(feedUrl);
    if (url.protocol !== "https:" || url.toString() !== feedUrl || !feedUrl.endsWith("/"))
      throw new Error("releasePolicy.ts: RELEASE_FEED_URL must be a canonical https base URL");
  }
  return { teamId, feedUrl };
}

/** The sealed electron-updater config (generic provider); the authority accepts exactly this. */
export function appUpdateYml(policy) {
  if (!policy.feedUrl) throw new Error("Release feed URL is not pinned");
  return `provider: generic\nurl: ${policy.feedUrl}\nupdaterCacheDirName: ${UPDATER_CACHE_DIR_NAME}\n`;
}

/** The team ID in "Developer ID Application: <name> (<TEAMID>)"; never auto-discovered. */
export function developerIdTeam(identity) {
  const match = /^Developer ID Application: [^\n]+ \(([A-Z0-9]{10})\)$/.exec(identity ?? "");
  if (!match) throw new Error('--sign expects "Developer ID Application: <name> (<TEAMID>)"');
  return match[1];
}

/** Same designated requirement as src/update/authority.ts developerIdRequirement (tested). */
export function developerIdRequirement(teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("invalid_team_id");
  return `=anchor apple generic and identifier "${APP_ID}" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${teamId}"`;
}

/**
 * Stable artifact names; the x64 name never contains "arm64" (MacUpdater picks by that). Prod (the
 * default) keeps cashU-<version>-mac-<arch>; another flavor uses its own prefix (cashU-Staging-...).
 */
export function artifactName(version, arch, extension, flavor = flavorById("prod")) {
  if (!["arm64", "x64"].includes(arch) || !["zip", "dmg"].includes(extension))
    throw new Error("Unexpected artifact");
  return `${flavor.artifactPrefix}-${version}-mac-${arch}.${extension}`;
}

/** The flavor sealed in an app bundle (its Info.plist CFBundleIdentifier through the table). */
export function bundleFlavor(app) {
  const id = execFileSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", join(app, "Contents", "Info.plist")],
    { encoding: "utf8" },
  ).trim();
  const flavor = flavorByBundleId(id);
  if (!flavor) throw new Error(`${app}: bundle ID ${id} is no cashU flavor`);
  return flavor;
}

/** Every release path refuses a bundle of a flavor without an update feed (the staging app). */
export function assertReleasableFlavor(app) {
  const flavor = bundleFlavor(app);
  if (!flavor.updateFeed || flavor.bundleId !== APP_ID)
    throw new Error(
      `${flavor.productName.toUpperCase()}: ${app} is the ${flavor.id} flavor (${flavor.bundleId}); only ${APP_ID} is ever released`,
    );
  return flavor;
}

/** Bundle-relative path of the sealed test-build marker (packages/node-host/src/testBuild.ts). */
export const TEST_BUILD_MARKER = "Contents/Resources/test-build.json";
/** electron-updater cache of a test build, never the release cache. */
export const TEST_UPDATER_CACHE_DIR_NAME = "cashu-updater-test";
const TEST_KEYS = ["schema", "kind", "feedUrl", "installRoot", "dataDir", "workspacesDir"];
const TEST_FEED = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/$/;

/** Every flavor's real default data dir and workspaces root names (lower case). */
const REAL_DATA_DIRS = new Set(
  FLAVOR_IDS.map((id) => flavorById(id).dataDirName.darwin.toLowerCase()),
);
const REAL_WORKSPACES = new Set(
  FLAVOR_IDS.map((id) => flavorById(id).workspacesDirName.toLowerCase()),
);

function testDir(value, label) {
  const fail = () => {
    throw new Error(
      `test build: ${label} must be an absolute, normalized directory outside /Applications, every flavor's default data dir and ~/Documents/cashU*`,
    );
  };
  if (typeof value !== "string" || value.length > 1024 || value.includes("\0")) fail();
  if (!isAbsolute(value) || resolve(value) !== value || value === "/") fail();
  const parts = value.split("/");
  if (parts[1] === "Applications") fail();
  for (let index = 0; index + 1 < parts.length; index += 1) {
    if (
      parts[index] === "Library" &&
      parts[index + 1] === "Application Support" &&
      REAL_DATA_DIRS.has(parts[index + 2]?.toLowerCase() ?? "")
    )
      fail();
    if (parts[index] === "Documents" && REAL_WORKSPACES.has(parts[index + 1]?.toLowerCase() ?? ""))
      fail();
  }
  return value;
}

/**
 * The test-build marker from JSON text or an object: exact keys, schema 1, kind "cashu-test-build",
 * feedUrl exactly http://127.0.0.1:<port>/, installRoot and dataDir safe absolute directories.
 */
export function parseTestBuild(input) {
  const record = typeof input === "string" ? JSON.parse(input) : input;
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("test build: the marker must be a JSON object");
  const keys = Object.keys(record);
  if (keys.length !== TEST_KEYS.length || TEST_KEYS.some((key) => !Object.hasOwn(record, key)))
    throw new Error(`test build: the marker needs exactly ${TEST_KEYS.join(", ")}`);
  if (record.schema !== 1 || record.kind !== "cashu-test-build")
    throw new Error('test build: schema must be 1 and kind "cashu-test-build"');
  const feed = typeof record.feedUrl === "string" ? TEST_FEED.exec(record.feedUrl) : null;
  if (!feed || Number(feed[1]) > 65535)
    throw new Error("test build: feedUrl must be http://127.0.0.1:<port>/");
  const installRoot = testDir(record.installRoot, "installRoot");
  const dataDir = testDir(record.dataDir, "dataDir");
  const workspacesDir = testDir(record.workspacesDir, "workspacesDir");
  const dirs = [installRoot, dataDir, workspacesDir];
  if (
    new Set(dirs).size !== dirs.length ||
    dirs.some((a) => dirs.some((b) => a !== b && b.startsWith(`${a}/`)))
  )
    throw new Error("test build: installRoot, dataDir and workspacesDir must be separate trees");
  return {
    schema: 1,
    kind: "cashu-test-build",
    feedUrl: record.feedUrl,
    installRoot,
    dataDir,
    workspacesDir,
  };
}

/** The sealed marker file text (fixed key order). */
export function testBuildJson(marker) {
  const checked = parseTestBuild(marker);
  return `${JSON.stringify(checked, TEST_KEYS, 2)}\n`;
}

/** The sealed app-update.yml of a test build: its local feed and the test cache dir. */
export function testAppUpdateYml(marker) {
  const checked = parseTestBuild(marker);
  return `provider: generic\nurl: ${checked.feedUrl}\nupdaterCacheDirName: ${TEST_UPDATER_CACHE_DIR_NAME}\n`;
}

/** The parsed marker of an app bundle, or null when it has none. */
export function readTestBuild(app) {
  const path = join(app, TEST_BUILD_MARKER);
  if (!existsSync(path) && !isLink(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error("test build: the marker is not a regular file");
  return parseTestBuild(readFileSync(path, "utf8"));
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every release path refuses a bundle that carries the test-build marker (valid or not). */
export function assertNoTestBuild(app) {
  const path = join(app, TEST_BUILD_MARKER);
  if (existsSync(path) || isLink(path))
    throw new Error(
      `TEST BUILD: ${app} carries ${TEST_BUILD_MARKER}; a test build can never be released`,
    );
}
