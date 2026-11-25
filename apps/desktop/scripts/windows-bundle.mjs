// The packaged identity of a Windows install dir (contract C5), written by package-windows.mjs and
// checked by verify-package-windows.mjs. The app checks the same rules at run time
// (packages/node-host/src/bundleIdentity.ts WINDOWS_LAYOUT, flavor.ts readAppIdentity); the tests
// prove every install written here verifies there. Everything here works on any OS (tested on macOS).
//
//   <install>\cashU.exe
//   <install>\resources\app-identity.json     {"schema":1,"bundleId":"io.utopiasoft.cashu","version":"X.Y.Z"}
//   <install>\resources\bundle-manifest.json  {"schema":1,"files":{"resources/host.mjs":"<sha256>",...}}
//
// The manifest lists every regular file under resources\ except itself, install-relative with
// forward slashes. The run-time content digest covers the whole install dir, so the installer must
// install exactly the unpacked bytes plus its uninstaller (compareInstalledTree).
//
// One version everywhere: Electron main names the host build after app.getVersion() (the
// package.json inside resources\app.asar), the host and the shim after app-identity.json, and the
// release after apps/desktop/package.json. checkWindowsInstall proves the first two equal the
// expected version; verify-package-windows.mjs pins that to apps/desktop/package.json.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const WINDOWS_EXECUTABLE = "cashU.exe";
export const APP_IDENTITY = "resources/app-identity.json";
export const BUNDLE_MANIFEST = "resources/bundle-manifest.json";
/** What NSIS adds to the install dir: the uninstaller electron-builder builds once per installer. */
export const UNINSTALLER = "Uninstall cashU.exe";
export const KEYRING_BINDING =
  "resources/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node";
/** Every manifest lists these (packages/node-host/src/bundleIdentity.ts WINDOWS_REQUIRED). */
export const WINDOWS_REQUIRED = Object.freeze([
  "resources/host.mjs",
  "resources/shim.mjs",
  "resources/notify-catalog-v1.json",
  "resources/skills/workspace-setup/SKILL.md",
  "resources/connectors/README.md",
  "resources/renderer/index.html",
  "resources/app.asar",
  APP_IDENTITY,
]);
/** Run-time limits of the manifest (bundleIdentity.ts manifestStamp). */
export const MANIFEST_MAX_FILES = 20_000;
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const APP_IDENTITY_MAX_BYTES = 4096;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The @electron/asar module electron-builder packs app.asar with (a dependency of its
 * app-builder-lib, resolved through `desktopDir`'s electron-builder): the archive is read back by the
 * same code that wrote it, and no second copy enters the dependency tree.
 * @param {string} desktopDir apps/desktop
 * @returns {{ extractFile(archive: string, file: string): Buffer, createPackage(src: string, dest: string): Promise<void> }}
 */
export function electronBuilderAsar(desktopDir) {
  const builder = createRequire(join(desktopDir, "package.json")).resolve(
    "electron-builder/cli.js",
  );
  const lib = createRequire(builder).resolve("app-builder-lib");
  return createRequire(lib)("@electron/asar");
}

/**
 * The version in the package.json of resources\app.asar: what Electron's app.getVersion() returns,
 * and so the version in Electron main's host build id.
 * @param {string} installDir
 * @param {(archive: string, file: string) => Buffer} readAsarFile
 */
export function appAsarVersion(installDir, readAsarFile) {
  const archive = absolutePath(installDir, "resources/app.asar");
  let manifest;
  try {
    manifest = JSON.parse(readAsarFile(archive, "package.json").toString("utf8"));
  } catch (error) {
    throw new Error(`${archive}: no readable package.json (${error.message})`);
  }
  const version = manifest?.version;
  if (typeof version !== "string" || !VERSION.test(version))
    throw new Error(`${archive}: package.json version ${JSON.stringify(version)}`);
  return version;
}

/** The installer's file name (flavor-config.cjs WINDOWS_ARTIFACT_NAME). */
export function windowsArtifactName(version) {
  if (!VERSION.test(version)) throw new Error(`Unexpected version ${version}`);
  return `cashU-${version}-win-x64.exe`;
}

/** The exact app-identity.json the run time accepts (flavor.ts readAppIdentity). */
export function appIdentityJson(bundleId, version) {
  if (!BUNDLE_ID.test(bundleId)) throw new Error(`Unexpected bundle ID ${bundleId}`);
  if (!VERSION.test(version)) throw new Error(`Unexpected version ${version}`);
  const text = `${JSON.stringify({ schema: 1, bundleId, version })}\n`;
  if (Buffer.byteLength(text) > APP_IDENTITY_MAX_BYTES) throw new Error("app-identity.json size");
  return text;
}

/**
 * Every entry under `dir`, install-relative with forward slashes: regular files, and anything that
 * is neither a file nor a directory (a symlink, a junction, a device) as `other`.
 */
export function installEntries(dir) {
  const files = [];
  const other = [];
  const visit = (absolute, relative) => {
    for (const name of readdirSync(absolute).sort()) {
      const path = join(absolute, name);
      const rel = relative === "" ? name : `${relative}/${name}`;
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, rel);
      else if (stat.isFile()) files.push(rel);
      else other.push(rel);
    }
  };
  visit(dir, "");
  return { files, other };
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

const absolutePath = (installDir, key) => join(installDir, ...key.split("/"));

/** Whether a manifest key has the shape the run time accepts. */
export function validManifestKey(key) {
  return (
    key.startsWith("resources/") &&
    !key.includes("\\") &&
    !key.includes("\0") &&
    !key.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

/**
 * The bundle manifest of the install dir: every regular file under resources\ but the manifest,
 * hashed. Refuses links and special files anywhere in the install (the installer could not carry
 * them, and the run time refuses junctions) and a manifest past the run-time limits.
 */
export function bundleManifest(installDir) {
  const { files, other } = installEntries(installDir);
  if (other.length > 0)
    throw new Error(`Links or special files in the install: ${other.join(", ")}`);
  const listed = files
    .filter((path) => path.startsWith("resources/") && path !== BUNDLE_MANIFEST)
    .sort();
  if (listed.length > MANIFEST_MAX_FILES) throw new Error("Bundle manifest: too many files");
  for (const key of listed)
    if (!validManifestKey(key)) throw new Error(`Bundle manifest: unexpected path ${key}`);
  const manifest = {
    schema: 1,
    files: Object.fromEntries(
      listed.map((key) => [key, sha256File(absolutePath(installDir, key))]),
    ),
  };
  for (const key of WINDOWS_REQUIRED)
    if (!Object.hasOwn(manifest.files, key)) throw new Error(`Bundle manifest: missing ${key}`);
  return manifest;
}

export function manifestJson(manifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(text) > MANIFEST_MAX_BYTES) throw new Error("Bundle manifest: too large");
  return text;
}

/**
 * Paths of git symlinks (mode 120000) in `git ls-files -s -z` output. A Windows checkout
 * (core.symlinks=false) materializes each as a text file holding the target path, which would ship
 * as a broken skill or connector file.
 */
export function trackedSymlinks(lsFilesOutput) {
  return lsFilesOutput
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const match = /^(\d{6}) [0-9a-f]+ \d$/.exec(entry.slice(0, tab));
      if (tab < 0 || !match) throw new Error(`Unexpected git ls-files entry: ${entry}`);
      return { mode: match[1], path: entry.slice(tab + 1) };
    })
    .filter((entry) => entry.mode === "120000")
    .map((entry) => entry.path);
}

function isPortableExecutable(path) {
  const fd = openSync(path, "r");
  const header = Buffer.alloc(2);
  try {
    readSync(fd, header, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  return header.toString("latin1") === "MZ";
}

/**
 * Checks an unpacked or installed Windows package and returns its manifest. `installed`: the
 * uninstaller NSIS writes must be present (and is the only file outside the package).
 * `readAsarFile` reads one file out of app.asar (`electronBuilderAsar(...).extractFile`): its
 * package.json must carry `version` too.
 * @param {string} installDir
 * @param {{ bundleId: string, version: string, installed?: boolean, readAsarFile: (archive: string, file: string) => Buffer }} expected
 */
export function checkWindowsInstall(installDir, expected) {
  const fail = (reason) => {
    throw new Error(`${installDir}: ${reason}`);
  };
  const { files, other } = installEntries(installDir);
  if (other.length > 0) fail(`links or special files: ${other.join(", ")}`);
  const fileSet = new Set(files);
  for (const name of [
    WINDOWS_EXECUTABLE,
    ...WINDOWS_REQUIRED,
    BUNDLE_MANIFEST,
    "resources/node_modules/@napi-rs/keyring/index.js",
    KEYRING_BINDING,
  ])
    if (!fileSet.has(name)) fail(`missing ${name}`);
  for (const name of [WINDOWS_EXECUTABLE, KEYRING_BINDING])
    if (!isPortableExecutable(absolutePath(installDir, name))) fail(`not a PE image: ${name}`);
  if (expected.installed && !fileSet.has(UNINSTALLER)) fail(`missing ${UNINSTALLER}`);
  if (!expected.installed && fileSet.has(UNINSTALLER))
    fail(`${UNINSTALLER} in the unpacked package`);
  // Nothing of the macOS bundle, no update feed (Windows updates are manual, C7), no test-build
  // marker (refused on Windows), no elevate.exe (per-machine installs only, never in the manifest).
  const forbidden = files.filter(
    (path) =>
      path.startsWith("resources/native/") ||
      path.startsWith("Library/") ||
      path.includes("/LaunchAgents/") ||
      /(^|\/)cashu-host-agent(\.[^/]*)?$/.test(path) ||
      /(^|\/)test-build\.json$/.test(path) ||
      path === "resources/app-update.yml" ||
      path === "resources/elevate.exe" ||
      /^resources\/node_modules\/@napi-rs\/keyring-(?!win32-x64-msvc\/)/.test(path),
  );
  if (forbidden.length > 0) fail(`files that never ship on Windows: ${forbidden.join(", ")}`);
  // app-identity.json: exactly the record the run time accepts, for this flavor and version.
  const identityPath = absolutePath(installDir, APP_IDENTITY);
  const identityText = readFileSync(identityPath, "utf8");
  if (lstatSync(identityPath).size > APP_IDENTITY_MAX_BYTES) fail("app-identity.json size");
  if (identityText !== appIdentityJson(expected.bundleId, expected.version))
    fail(`app-identity.json is not ${appIdentityJson(expected.bundleId, expected.version).trim()}`);
  // app.asar: Electron main's version (app.getVersion()) must be the one the host and shim read.
  const asarVersion = appAsarVersion(installDir, expected.readAsarFile);
  if (asarVersion !== expected.version)
    fail(`resources/app.asar package.json version ${asarVersion}, expected ${expected.version}`);
  // bundle-manifest.json: the run-time shape, every resource listed, every hash current.
  const manifestPath = absolutePath(installDir, BUNDLE_MANIFEST);
  if (lstatSync(manifestPath).size > MANIFEST_MAX_BYTES) fail("bundle-manifest.json size");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(",") !== "files,schema" ||
    manifest.schema !== 1 ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    fail("bundle-manifest.json shape");
  const keys = Object.keys(manifest.files);
  if (keys.length > MANIFEST_MAX_FILES) fail("bundle-manifest.json lists too many files");
  const resources = files.filter(
    (path) => path.startsWith("resources/") && path !== BUNDLE_MANIFEST,
  );
  const unlisted = resources.filter((path) => !Object.hasOwn(manifest.files, path));
  if (unlisted.length > 0) fail(`resources missing from the manifest: ${unlisted.join(", ")}`);
  for (const key of keys) {
    const digest = manifest.files[key];
    if (!validManifestKey(key) || key === BUNDLE_MANIFEST) fail(`manifest key ${key}`);
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) fail(`manifest hash ${key}`);
    if (!fileSet.has(key)) fail(`manifest lists a missing file ${key}`);
    if (sha256File(absolutePath(installDir, key)) !== digest) fail(`manifest mismatch ${key}`);
  }
  for (const key of WINDOWS_REQUIRED)
    if (!Object.hasOwn(manifest.files, key)) fail(`manifest misses ${key}`);
  return manifest;
}

/**
 * How an installed tree differs from the unpacked package it came from: the installer must write
 * exactly the unpacked bytes plus its uninstaller (the run-time build id hashes the whole install).
 */
export function compareInstalledTree(unpackedDir, installedDir) {
  const unpacked = installEntries(unpackedDir);
  const installed = installEntries(installedDir);
  const unpackedSet = new Set(unpacked.files);
  const installedSet = new Set(installed.files);
  const missing = unpacked.files.filter((path) => !installedSet.has(path));
  const extra = installed.files.filter((path) => !unpackedSet.has(path) && path !== UNINSTALLER);
  if (!installedSet.has(UNINSTALLER)) missing.push(UNINSTALLER);
  const changed = unpacked.files.filter(
    (path) =>
      installedSet.has(path) &&
      sha256File(absolutePath(unpackedDir, path)) !== sha256File(absolutePath(installedDir, path)),
  );
  const other = [...unpacked.other, ...installed.other];
  return { missing, extra, changed, other };
}

/** The common name of an X.500 subject ("CN=Name, O=..." or CN="Name, Inc."), or null. */
export function subjectCommonName(subject) {
  const match = /(?:^|,\s*)CN=("(?:[^"]|"")*"|[^,]*)/.exec(subject ?? "");
  if (!match) return null;
  const value = match[1].trim();
  return value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value;
}

/**
 * Problems in Get-AuthenticodeSignature records ({ Path, Status, Subject, TimeStamper }) against
 * the expected publisher: every file Valid, signed by that common name, with a timestamp.
 */
export function authenticodeProblems(records, publisher) {
  const problems = [];
  for (const record of records) {
    if (record.Status !== "Valid") problems.push(`${record.Path}: status ${record.Status}`);
    else if (subjectCommonName(record.Subject) !== publisher)
      problems.push(`${record.Path}: signed by ${record.Subject}`);
    else if (!record.TimeStamper) problems.push(`${record.Path}: no timestamp`);
  }
  return problems;
}

/** Files Authenticode must cover in a signed package: every .exe, .dll and .node. */
export function signableFiles(installDir) {
  return installEntries(installDir)
    .files.filter((path) => /\.(exe|dll|node)$/i.test(path))
    .map((path) => join(installDir, ...path.split("/")));
}
