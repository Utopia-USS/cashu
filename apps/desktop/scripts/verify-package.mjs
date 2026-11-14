// Verifies a packaged cashU.app for one architecture.
//
//   node apps/desktop/scripts/verify-package.mjs <cashU.app> <arm64|x64>
//        [--release | --test-build] [--notarized]
//
// Always: layout, bundle ID, bundle-manifest.json hashes, every Mach-O built only for <arch>, the
// sealed app-update.yml equal to the pinned policy (when pinned), codesign --verify --deep --strict.
// --release: the policy in src/update/releasePolicy.ts is pinned, app.asar embeds the same feed URL
// and team ID (the compiled update gate agrees with the sealed feed), every Mach-O is signed by that
// Developer ID team with the hardened runtime and a secure timestamp, entitlements are allow-jit on
// the main and helper executables and none elsewhere, and the app meets the designated requirement
// the update authority checks, and the app carries NO test-build marker (assertNoTestBuild: a test
// build can never be released). --test-build: the same signing checks for a Developer ID signed
// test build, which must carry a valid, manifest-listed Contents/Resources/test-build.json and the
// test app-update.yml it implies (local feed, test cache dir). Without either flag a marker, when
// present, must agree with app-update.yml. --notarized (with --release or --test-build):
// Gatekeeper accepts the app as a notarized Developer ID app and its stapled ticket validates.
// Flavors (packages/node-host/src/flavor.json): the bundle ID names the flavor (an unknown one is
// refused); its product name, URL scheme and host agent plist must match the table. A flavor without
// an update feed (staging) carries no app-update.yml and no test-build marker, and --release /
// --test-build refuse it (assertReleasableFlavor): it is never released.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { agentPlistPath } from "./flavor.mjs";
import {
  APP_ID,
  appUpdateYml,
  assertNoTestBuild,
  assertReleasableFlavor,
  bundleFlavor,
  developerIdRequirement,
  readReleasePolicy,
  readTestBuild,
  TEST_BUILD_MARKER,
  testAppUpdateYml,
} from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const app = realpathSync.native(resolve(process.argv[2] ?? ""));
const arch = process.argv[3] ?? process.arch;
const flags = process.argv.slice(4);
const release = flags.includes("--release");
const testBuildMode = flags.includes("--test-build");
const signed = release || testBuildMode;
const notarized = flags.includes("--notarized");
if (
  !app.endsWith(".app") ||
  !["arm64", "x64"].includes(arch) ||
  flags.some((flag) => !["--release", "--test-build", "--notarized"].includes(flag)) ||
  (release && testBuildMode) ||
  (notarized && !signed)
)
  throw new Error(
    "usage: node verify-package.mjs <cashU.app> <arm64|x64> [--release | --test-build] [--notarized]",
  );
// First, before anything else: a release never carries the test-build marker, and only the prod
// flavor is ever released or signed as a test build.
if (release) assertNoTestBuild(app);
const flavor = signed ? assertReleasableFlavor(app) : bundleFlavor(app);
process.stdout.write(`flavor ${flavor.id}: ${flavor.bundleId}\n`);
const testBuild = readTestBuild(app);
if (testBuildMode && !testBuild) throw new Error(`--test-build: ${TEST_BUILD_MARKER} is missing`);
if (testBuild) process.stdout.write(`TEST BUILD: feed ${testBuild.feedUrl}\n`);
const xarch = arch === "x64" ? "x86_64" : "arm64";
const keyringBinding = `Contents/Resources/node_modules/@napi-rs/keyring-darwin-${arch}/keyring.darwin-${arch}.node`;
const contents = join(app, "Contents");
const info = join(contents, "Info.plist");
function command(name, args) {
  return execFileSync(name, args, { encoding: "utf8" }).trim();
}
function combined(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}
function plist(key) {
  return command("plutil", ["-extract", key, "raw", info]);
}
if (plist("CFBundleIdentifier") !== flavor.bundleId) throw new Error("Wrong app ID");
if (signed && flavor.bundleId !== APP_ID) throw new Error("Wrong app ID for a signed build");
if (plist("CFBundleExecutable") !== "cashU") throw new Error("Wrong executable name");
if (plist("CFBundleName") !== flavor.productName) throw new Error("Wrong product name");
if (plist("CFBundleURLTypes.0.CFBundleURLSchemes.0") !== flavor.urlScheme)
  throw new Error("Wrong URL scheme");
const agentPlist = agentPlistPath(flavor);
if (
  !readFileSync(join(app, agentPlist), "utf8").includes(`<string>${flavor.hostAgentLabel}</string>`)
)
  throw new Error("The host agent plist does not carry the flavor's label");
const otherPlists = existsSync(join(contents, "Library/LaunchAgents"))
  ? readdirSync(join(contents, "Library/LaunchAgents")).filter(
      (name) => `Contents/Library/LaunchAgents/${name}` !== agentPlist,
    )
  : [];
if (otherPlists.length > 0) throw new Error(`Foreign launch agents: ${otherPlists.join(", ")}`);
const required = [
  "Contents/MacOS/cashU",
  "Contents/MacOS/cashu-host-agent",
  agentPlist,
  "Contents/Resources/host.mjs",
  "Contents/Resources/app.asar",
  "Contents/Resources/shim.mjs",
  "Contents/Resources/notify-catalog-v1.json",
  "Contents/Resources/native/CashUNotifications.node",
  "Contents/Resources/native/CashUHostService.node",
  "Contents/Resources/node_modules/@napi-rs/keyring/index.js",
  keyringBinding,
  "Contents/Resources/skills",
  "Contents/Resources/connectors",
  "Contents/Resources/skills/workspace-setup/SKILL.md",
  "Contents/Resources/connectors/README.md",
  "Contents/Resources/renderer/index.html",
];
for (const name of required) {
  const path = join(app, name);
  if (!existsSync(path)) throw new Error(`Missing ${name}`);
  const actual = realpathSync.native(path);
  const rel = relative(app, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Escaping ${name}`);
}
for (const name of ["Contents/MacOS/cashU", "Contents/MacOS/cashu-host-agent"]) {
  const path = join(app, name);
  if (!lstatSync(path).isFile() || (lstatSync(path).mode & 0o111) === 0)
    throw new Error(`Not executable: ${name}`);
}
function machO(path) {
  const fd = openSync(path, "r");
  const header = Buffer.alloc(4);
  try {
    readSync(fd, header, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  return [
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ].includes(header.toString("hex"));
}
function regularFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? regularFiles(path) : entry.isFile() ? [path] : [];
  });
}
// Every Mach-O is built for exactly the target architecture: no universal or foreign slices.
const machOs = regularFiles(contents).filter(machO);
for (const name of required.filter((path) => path.endsWith(".node") || path.includes("/MacOS/")))
  if (!machOs.includes(join(app, name))) throw new Error(`Not a Mach-O: ${name}`);
for (const path of machOs) {
  const archs = command("lipo", ["-archs", path]);
  if (archs !== xarch) throw new Error(`Wrong arch (${archs}): ${relative(app, path)}`);
}
const manifest = JSON.parse(readFileSync(join(contents, "Resources/bundle-manifest.json"), "utf8"));
if (
  manifest.schema !== 1 ||
  !manifest.files ||
  typeof manifest.files !== "object" ||
  Object.keys(manifest.files).length < required.length
)
  throw new Error("Manifest schema");
for (const name of required) {
  if (name === "Contents/MacOS/cashU" || name.endsWith("/skills") || name.endsWith("/connectors"))
    continue;
  if (typeof manifest.files[name] !== "string") throw new Error(`Manifest missing: ${name}`);
}
for (const [name, expected] of Object.entries(manifest.files)) {
  const actual = createHash("sha256")
    .update(readFileSync(join(app, name)))
    .digest("hex");
  if (actual !== expected) throw new Error(`Manifest mismatch: ${name}`);
}
const policy = readReleasePolicy(root);
const feedPath = join(contents, "Resources/app-update.yml");
if (signed && (!policy.teamId || !policy.feedUrl)) throw new Error("Release policy is not pinned");
if (!flavor.updateFeed) {
  // No feed at all: the updater reports unavailable (and the authority refuses the flavor first).
  if (testBuild) throw new Error(`The ${flavor.id} flavor never carries ${TEST_BUILD_MARKER}`);
  if (
    existsSync(feedPath) ||
    typeof manifest.files["Contents/Resources/app-update.yml"] === "string"
  )
    throw new Error(`The ${flavor.id} flavor must not seal an app-update.yml`);
} else if (testBuild) {
  if (typeof manifest.files[TEST_BUILD_MARKER] !== "string")
    throw new Error(`Manifest missing: ${TEST_BUILD_MARKER}`);
  if (!existsSync(feedPath) || !lstatSync(feedPath).isFile()) throw new Error("No app-update.yml");
  if (readFileSync(feedPath, "utf8") !== testAppUpdateYml(testBuild))
    throw new Error("app-update.yml differs from the test build's local feed");
  if (typeof manifest.files["Contents/Resources/app-update.yml"] !== "string")
    throw new Error("Manifest missing: app-update.yml");
} else if (policy.feedUrl || release) {
  if (!existsSync(feedPath) || !lstatSync(feedPath).isFile()) throw new Error("No app-update.yml");
  if (readFileSync(feedPath, "utf8") !== appUpdateYml(policy))
    throw new Error("app-update.yml differs from the pinned release policy");
  if (typeof manifest.files["Contents/Resources/app-update.yml"] !== "string")
    throw new Error("Manifest missing: app-update.yml");
}
command("codesign", ["--verify", "--deep", "--strict", app]);
if (signed) {
  const asar = readFileSync(join(contents, "Resources/app.asar"));
  for (const literal of [`"${policy.feedUrl}"`, `"${policy.teamId}"`])
    if (!asar.includes(Buffer.from(literal)))
      throw new Error(`app.asar does not embed the pinned policy ${literal}`);
  const mainExecutable = join(contents, "MacOS/cashU");
  for (const path of machOs) {
    const name = relative(app, path);
    const details = combined("codesign", ["-dv", "--verbose=4", path]);
    if (
      details.status !== 0 ||
      !details.text.split("\n").includes(`TeamIdentifier=${policy.teamId}`) ||
      !/^CodeDirectory .*flags=0x10000\(runtime\)/m.test(details.text) ||
      !/^Timestamp=/m.test(details.text) ||
      !/^Authority=Developer ID Application: /m.test(details.text)
    )
      throw new Error(`Not a Developer ID ${policy.teamId} hardened, timestamped Mach-O: ${name}`);
    const listed = combined("codesign", ["-d", "--entitlements", "-", "--xml", path]);
    const keys = [...listed.stdout.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
    const jit = path === mainExecutable || /\.app\/Contents\/MacOS\/[^/]+$/.test(name);
    const expected = jit ? ["com.apple.security.cs.allow-jit"] : [];
    if (listed.status !== 0 || keys.join(",") !== expected.join(","))
      throw new Error(`Unexpected entitlements (${keys.join(",") || "none"}): ${name}`);
  }
  command("codesign", ["--verify", "--strict", "-R", developerIdRequirement(policy.teamId), app]);
  process.stdout.write(
    testBuild
      ? `TEST BUILD signed: ${machOs.length} Mach-O, team ${policy.teamId}, feed ${testBuild.feedUrl}\n`
      : `Release-signed: ${machOs.length} Mach-O, team ${policy.teamId}, feed ${policy.feedUrl}\n`,
  );
}
if (notarized) {
  const gate = combined("spctl", ["-a", "-vv", "-t", "execute", app]);
  if (
    gate.status !== 0 ||
    !gate.text.includes(": accepted") ||
    !gate.text.includes("source=Notarized Developer ID")
  )
    throw new Error(`Gatekeeper refused the app: ${gate.text}`);
  process.stdout.write(`${gate.text}\n`);
  const staple = combined("xcrun", ["stapler", "validate", app]);
  if (staple.status !== 0) throw new Error(`Stapled ticket invalid: ${staple.text}`);
  process.stdout.write(`${staple.text.split("\n").at(-1)}\n`);
}
process.stdout.write(`Verified ${app} (${arch})${testBuild ? " TEST BUILD" : ""}\n`);
