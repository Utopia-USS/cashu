// Builds cashU.app for one macOS architecture (arm64 or x64; never universal) and zips it.
//
//   node apps/desktop/scripts/package-macos.mjs <arm64|x64> [--dmg] [--reuse-desktop] [--out <dir>]
//        [--sign "Developer ID Application: <name> (<TEAMID>)" [--notarize <keychain-profile>]]
//
// Default (dev, e2e, CI): ad hoc signature, artifacts in build/t46. Nothing is auto-discovered:
// without --sign no identity is used, and CSC_* / APPLE_* / notarization env is stripped.
//
// Release mode (--sign): this script is the only signer (electron-builder runs with identity null).
// Inside out, with the hardened runtime and a secure timestamp: every nested Mach-O file (Electron
// dylibs, crashpad, ShipIt, .node addons, cashu-host-agent), then the nested bundles (Electron
// frameworks, helper apps), then bundle-manifest.json (hashes Resources incl. app-update.yml), then
// the app. The team in --sign must equal RELEASE_TEAM_ID. Every codesign has a deadline: the key
// must be usable without a keychain dialog ("Always Allow" for codesign), checked before the build.
// Release entitlements (build/entitlements.release.mac.plist) go ONLY on the main executable and
// the four Electron helper apps: com.apple.security.cs.allow-jit, because V8 needs MAP_JIT pages
// under the hardened runtime in Electron main, the renderer, GPU (SwiftShader) and utility helpers
// and in the host (the cashU executable run with ELECTRON_RUN_AS_NODE); Chromium and
// @electron/osx-sign ship the same key there. Dropped on purpose: allow-unsigned-executable-memory
// (not needed with allow-jit since Electron 12), disable-library-validation (every library these
// processes load carries the same Team ID), device / personal-information keys (unused). Nested
// dylibs, chrome_crashpad_handler, ShipIt, the .node addons and cashu-host-agent get none. The ad
// hoc build keeps build/entitlements.mac.plist: ad hoc code has no Team ID, so library validation
// would refuse its own addons.
// With --notarize: zip -> notarytool (wait) -> staple the app -> re-zip the stapled app; with --dmg
// also dmg from the stapled app -> sign -> notarize -> staple. Every notarization prints its
// submission id and status. Final checks: verify-package.mjs --release [--notarized] and spctl /
// stapler on the dmg. Artifacts in --out (relative to the current directory):
//   cashU-<version>-mac-arm64.{zip,dmg}, cashU-<version>-mac-x64.{zip,dmg}
// One latest-mac.yml can list both zips: electron-updater's MacUpdater picks the file whose name
// contains "arm64" on Apple silicon and drops those files on Intel. Separate arches (not
// universal): half the download, and native modules are built per arch.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appUpdateYml,
  artifactName,
  developerIdTeam,
  readReleasePolicy,
} from "./release-policy.mjs";
import { checkedRendererArtifact, rendererArtifactRoot } from "./renderer-artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const build = join(root, "build", "t46");
const usage =
  "usage: node package-macos.mjs <arm64|x64> [--dmg] [--reuse-desktop] [--out <dir>] " +
  '[--sign "Developer ID Application: <name> (<TEAMID>)" [--notarize <keychain-profile>]]';
const args = process.argv.slice(2);
const arch = args[0] ?? process.arch;
let withDmg = false;
let reuseDesktop = false;
let out = build;
let identity = null;
let notaryProfile = null;
for (let index = 1; index < args.length; index += 1) {
  const flag = args[index];
  if (flag === "--dmg") withDmg = true;
  else if (flag === "--reuse-desktop") reuseDesktop = true;
  else if (["--out", "--sign", "--notarize"].includes(flag)) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage);
    index += 1;
    if (flag === "--out") out = resolve(value);
    else if (flag === "--sign") identity = value;
    else notaryProfile = value;
  } else throw new Error(usage);
}
if (!["arm64", "x64"].includes(arch)) throw new Error(usage);
if (notaryProfile && !identity) throw new Error("--notarize needs --sign");
if (notaryProfile && !/^[A-Za-z0-9._-]{1,64}$/.test(notaryProfile))
  throw new Error("Unexpected keychain profile name");
const policy = readReleasePolicy(root);
if (identity) {
  if (!policy.teamId || !policy.feedUrl) throw new Error("Release policy is not pinned");
  if (developerIdTeam(identity) !== policy.teamId)
    throw new Error(`--sign team differs from RELEASE_TEAM_ID ${policy.teamId}`);
}
const resources = join(build, "resources");
rmSync(resources, { recursive: true, force: true });
rmSync(join(build, "electron-builder"), { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
mkdirSync(out, { recursive: true });
const env = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES: "false",
};
for (const key of Object.keys(env)) {
  if (
    /^(CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$|NOTARIZE_|ELECTRON_BUILDER_PUBLISH)/.test(key) &&
    key !== "CSC_IDENTITY_AUTO_DISCOVERY"
  )
    delete env[key];
}
function run(program, commandArgs, cwd = root, timeout = undefined) {
  const result = spawnSync(program, commandArgs, { cwd, env, stdio: "inherit", timeout });
  if (result.error?.code === "ETIMEDOUT")
    throw new Error(`${program} timed out: a keychain access prompt for the signing key?`);
  if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? "signal"})`);
}
function capture(program, commandArgs) {
  const result = spawnSync(program, commandArgs, { cwd: root, env, encoding: "utf8" });
  return { status: result.status, text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
// A Developer ID signature needs the private key without a keychain dialog (this script cannot
// answer one): every codesign gets a deadline, and a scratch signature runs before the build.
const SIGN_TIMEOUT_MS = 180_000;
if (identity) {
  const probe = join(build, "sign-probe");
  rmSync(probe, { force: true });
  copyFileSync("/usr/bin/true", probe);
  try {
    run("codesign", ["--remove-signature", probe]);
    run("codesign", ["--force", "--sign", identity, "--timestamp", probe], root, 60_000);
  } finally {
    rmSync(probe, { force: true });
  }
}
if (reuseDesktop) {
  if (
    !existsSync(join(root, "apps/desktop/dist/main.js")) ||
    !existsSync(join(root, "apps/desktop/dist/preload.cjs")) ||
    !existsSync(join(rendererArtifactRoot(root), "index.html"))
  )
    throw new Error("Built desktop inputs are missing");
} else run("pnpm", ["--filter", "@cashu/desktop", "build"]);
run("node", [join(root, "apps/desktop/scripts/build-host.mjs"), resources, arch]);
run("node", [join(root, "apps/desktop/scripts/build-native.mjs"), resources, arch]);
copyFileSync(
  join(root, "apps/desktop/resources/notify-catalog-v1.json"),
  join(resources, "notify-catalog-v1.json"),
);
for (const name of ["skills", "connectors"]) {
  const source = name === "skills" ? join(root, ".claude", "skills") : join(root, "connectors");
  cpSync(source, join(resources, name), { recursive: true, force: true, verbatimSymlinks: true });
}
const renderer = checkedRendererArtifact(root);
cpSync(renderer, join(resources, "renderer"), {
  recursive: true,
  force: true,
  filter: (name) => !name.endsWith(".map"),
});
function validateLinks(dir, rootDir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) validateLinks(path, rootDir);
    if (!entry.isSymbolicLink()) continue;
    const target = realpathSync.native(path);
    const rel = relative(rootDir, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error(`Resource symlink escapes staging: ${path}`);
  }
}
validateLinks(resources, resources);
run(
  "pnpm",
  [
    "exec",
    "electron-builder",
    "--mac",
    "dir",
    `--${arch}`,
    "--config",
    join(root, "apps/desktop/build/electron-builder.config.cjs"),
    "--publish",
    "never",
  ],
  join(root, "apps/desktop"),
);

const app = join(build, "electron-builder", arch === "arm64" ? "mac-arm64" : "mac", "cashU.app");
if (!existsSync(app)) throw new Error(`Builder app missing: ${app}`);
const contents = join(app, "Contents");
// The sealed updater config: written before any signature and listed in bundle-manifest.json.
if (policy.feedUrl)
  writeFileSync(join(contents, "Resources", "app-update.yml"), appUpdateYml(policy));
const entitlements = join(root, "apps/desktop/build/entitlements.mac.plist");
const releaseEntitlements = join(root, "apps/desktop/build/entitlements.release.mac.plist");
function machO(path) {
  if (!lstatSync(path).isFile()) return false;
  const fd = openSync(path, "r");
  const header = Buffer.alloc(4);
  try {
    readSync(fd, header, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  const magic = header.toString("hex");
  return [
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ].includes(magic);
}
function paths(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? paths(path) : entry.isFile() ? [path] : [];
  });
}
function bundles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const path = join(dir, entry.name);
    return [...(/\.(app|framework)$/.test(entry.name) ? [path] : []), ...bundles(path)];
  });
}
function bundleExecutable(bundle) {
  const app = bundle.endsWith(".app");
  const info = app
    ? join(bundle, "Contents", "Info.plist")
    : join(bundle, "Resources", "Info.plist");
  const result = capture("plutil", ["-extract", "CFBundleExecutable", "raw", info]);
  if (result.status !== 0 || !/^[^/\n]+$/.test(result.text))
    throw new Error(`No executable in ${bundle}`);
  return realpathSync.native(join(bundle, ...(app ? ["Contents", "MacOS"] : []), result.text));
}
function codesign(path, entitlementsFile) {
  run(
    "codesign",
    [
      "--force",
      "--sign",
      identity ?? "-",
      ...(identity ? ["--timestamp"] : []),
      "--options",
      "runtime",
      ...(entitlementsFile ? ["--entitlements", entitlementsFile] : []),
      path,
    ],
    root,
    identity ? SIGN_TIMEOUT_MS : undefined,
  );
}
const mainExecutable = join(contents, "MacOS", "cashU");
if (identity) {
  // Inside out: a container is signed after everything under it (its path is a strict prefix, so
  // longest path first). A nested bundle's main executable is signed with its bundle, not alone.
  const nestedBundles = bundles(contents);
  const bundleMains = new Set(nestedBundles.map(bundleExecutable));
  const files = paths(contents).filter(
    (path) => path !== mainExecutable && !bundleMains.has(realpathSync.native(path)) && machO(path),
  );
  const items = [
    ...files.map((path) => ({ path, entitlements: null })),
    ...nestedBundles.map((path) => ({
      path,
      entitlements: path.endsWith(".app") ? releaseEntitlements : null,
    })),
  ];
  for (const item of items.sort((a, b) => b.path.length - a.path.length))
    codesign(item.path, item.entitlements);
} else {
  const nested = paths(contents).filter((path) => path !== mainExecutable && machO(path));
  for (const path of nested.sort((a, b) => b.length - a.length)) codesign(path, entitlements);
}
const manifestFiles = [
  ...paths(join(contents, "Resources")).map((path) => relative(app, path)),
  "Contents/MacOS/cashu-host-agent",
  "Contents/Library/LaunchAgents/io.utopiasoft.cashu.host.plist",
]
  .filter((path) => path !== "Contents/Resources/bundle-manifest.json")
  .sort();
const files = Object.fromEntries(
  manifestFiles.map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(join(app, name)))
      .digest("hex"),
  ]),
);
writeFileSync(
  join(contents, "Resources", "bundle-manifest.json"),
  `${JSON.stringify({ schema: 1, files }, null, 2)}\n`,
);
codesign(app, identity ? releaseEntitlements : entitlements);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
const verify = join(root, "apps/desktop/scripts/verify-package.mjs");
run("node", [verify, app, arch, ...(identity ? ["--release"] : [])]);

const version = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).version;
const zip = join(out, artifactName(version, arch, "zip"));
const dmg = join(out, artifactName(version, arch, "dmg"));
for (const path of [zip, dmg]) rmSync(path, { force: true });
const notarizations = [];
function notarize(path) {
  const label = basename(path);
  const result = spawnSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      path,
      "--keychain-profile",
      notaryProfile,
      "--wait",
      "--timeout",
      "2h",
      "--output-format",
      "json",
    ],
    { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const line = (result.stdout ?? "")
    .split("\n")
    .reverse()
    .find((text) => text.trim().startsWith("{"));
  let parsed = {};
  try {
    parsed = JSON.parse(line ?? "{}");
  } catch {}
  const record = { artifact: label, id: parsed.id ?? null, status: parsed.status ?? "unknown" };
  notarizations.push(record);
  process.stdout.write(`notarization ${label}: id=${record.id} status=${record.status}\n`);
  if (record.status !== "Accepted") {
    if (record.id)
      run("xcrun", ["notarytool", "log", record.id, "--keychain-profile", notaryProfile]);
    throw new Error(`Notarization of ${label} ended ${record.status}`);
  }
}
function zipApp(target) {
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, target]);
  run("unzip", ["-tq", target]);
}
if (notaryProfile) {
  // Apple notarizes the zip; the updater zip then carries the stapled app.
  const submission = join(build, "notarize", artifactName(version, arch, "zip"));
  rmSync(dirname(submission), { recursive: true, force: true });
  mkdirSync(dirname(submission), { recursive: true });
  zipApp(submission);
  notarize(submission);
  rmSync(dirname(submission), { recursive: true, force: true });
  run("xcrun", ["stapler", "staple", app]);
  run("xcrun", ["stapler", "validate", app]);
  run("node", [verify, app, arch, "--release", "--notarized"]);
}
zipApp(zip);
if (withDmg) {
  run("hdiutil", ["create", "-srcfolder", app, "-format", "UDZO", "-volname", "cashU", dmg]);
  // A disk image carries no hardened runtime or entitlements: identity and timestamp only.
  if (identity)
    run("codesign", ["--force", "--sign", identity, "--timestamp", dmg], root, SIGN_TIMEOUT_MS);
  if (notaryProfile) {
    notarize(dmg);
    run("xcrun", ["stapler", "staple", dmg]);
    run("xcrun", ["stapler", "validate", dmg]);
    const gate = capture("spctl", [
      "-a",
      "-t",
      "open",
      "--context",
      "context:primary-signature",
      "-vv",
      dmg,
    ]);
    process.stdout.write(`${gate.text}\n`);
    if (gate.status !== 0 || !gate.text.includes("source=Notarized Developer ID"))
      throw new Error("Gatekeeper refused the dmg");
  }
}
const artifacts = [zip, ...(withDmg ? [dmg] : [])].map((path) => ({
  name: basename(path),
  bytes: statSync(path).size,
  sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
}));
const mode = notaryProfile ? "notarized" : identity ? "signed" : "adhoc";
process.stdout.write(
  `release-summary ${JSON.stringify({ version, arch, mode, out, artifacts, notarizations })}\n`,
);
process.stdout.write(`${app}\n`);
