// Verifies a Windows x64 package: the unpacked dir electron-builder made, or an installed copy.
//
//   node apps/desktop/scripts/verify-package-windows.mjs <dir> [--version <X.Y.Z>]
//        [--installed-from <unpacked dir>] [--signed <publisher> [--installer <cashU-...-win-x64.exe>]]
//
// Always (any OS): the C5 layout (cashU.exe and resources\{host.mjs, shim.mjs, app.asar, ...}), the
// keyring win32-x64-msvc binding, app-identity.json exactly {schema 1, the prod bundle ID, the
// version}, one version everywhere (app-identity.json, which the host and the shim read = the
// package.json inside app.asar, which Electron main's build id uses = apps/desktop/package.json =
// --version when given), bundle-manifest.json in the run-time shape listing every resource file
// with a current hash, no links or special files, nothing of the macOS bundle
// (native\, host agent, launch agent plist), no app-update.yml, no test-build.json, no elevate.exe.
// --installed-from: <dir> is an install made by the installer from that unpacked dir; it must hold
// exactly the unpacked bytes plus "Uninstall cashU.exe" (the run-time build id hashes the whole
// install dir). On Windows also: cashU.exe's version resource names cashU and the version.
// --signed (Windows only): Get-AuthenticodeSignature reports Valid, the publisher's common name and
// a timestamp on every .exe, .dll and .node in <dir>, and on --installer when given.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flavorById } from "./flavor.mjs";
import {
  authenticodeProblems,
  checkWindowsInstall,
  compareInstalledTree,
  electronBuilderAsar,
  signableFiles,
  WINDOWS_EXECUTABLE,
} from "./windows-bundle.mjs";

const USAGE =
  "usage: node verify-package-windows.mjs <dir> [--version <X.Y.Z>] [--installed-from <unpacked dir>] [--signed <publisher> [--installer <exe>]]";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [target, ...rest] = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < rest.length; index += 2) {
  const flag = rest[index];
  const value = rest[index + 1];
  if (
    !["--version", "--installed-from", "--signed", "--installer"].includes(flag) ||
    flags.has(flag) ||
    value === undefined ||
    value === "" ||
    value.startsWith("--")
  )
    throw new Error(USAGE);
  flags.set(flag, value);
}
if (!target || !existsSync(target)) throw new Error(USAGE);
if (flags.has("--installer") && !flags.has("--signed")) throw new Error(USAGE);
const dir = realpathSync.native(resolve(target));
const flavor = flavorById("prod");
const desktopDir = join(root, "apps/desktop");
const version = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8")).version;
// The checkout's version is the release's: a package of any other version is not this release.
if (flags.has("--version") && flags.get("--version") !== version)
  throw new Error(
    `--version ${flags.get("--version")} is not apps/desktop/package.json ${version}`,
  );
const unpacked = flags.get("--installed-from");

const { extractFile } = electronBuilderAsar(desktopDir);
const manifest = checkWindowsInstall(dir, {
  bundleId: flavor.bundleId,
  version,
  installed: unpacked !== undefined,
  readAsarFile: extractFile,
});
process.stdout.write(
  `layout, identity, app.asar version and manifest ok: ${Object.keys(manifest.files).length} resources, ${flavor.bundleId} ${version}\n`,
);
if (unpacked !== undefined) {
  const diff = compareInstalledTree(realpathSync.native(resolve(unpacked)), dir);
  const problems = [
    ...diff.missing.map((path) => `missing ${path}`),
    ...diff.extra.map((path) => `not from the package: ${path}`),
    ...diff.changed.map((path) => `differs from the package: ${path}`),
    ...diff.other.map((path) => `link or special file: ${path}`),
  ];
  if (problems.length > 0) throw new Error(`Installed tree:\n  ${problems.join("\n  ")}`);
  process.stdout.write("installed tree = unpacked package + uninstaller\n");
}

/** Runs a PowerShell script with inputs in the environment (never interpolated into the script). */
function powershell(script, inputs) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", env: { ...process.env, ...inputs }, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(`powershell failed (${result.status ?? "signal"}): ${result.stderr ?? ""}`);
  const parsed = JSON.parse(result.stdout.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

if (process.platform === "win32") {
  const [info] = powershell(
    "$v = (Get-Item -LiteralPath $env:CASHU_VERIFY_EXE).VersionInfo; [pscustomobject]@{ ProductName = $v.ProductName; ProductVersion = $v.ProductVersion; FileVersion = $v.FileVersion } | ConvertTo-Json -Compress",
    { CASHU_VERIFY_EXE: join(dir, WINDOWS_EXECUTABLE) },
  );
  const numeric = version.replace(/-.*$/, "");
  const versions = [version, numeric, `${numeric}.0`];
  if (info.ProductName !== flavor.productName || !versions.includes(info.ProductVersion))
    throw new Error(
      `${WINDOWS_EXECUTABLE} version resource: ${info.ProductName} ${info.ProductVersion}, expected ${flavor.productName} ${version}`,
    );
  process.stdout.write(`${WINDOWS_EXECUTABLE}: ${info.ProductName} ${info.ProductVersion}\n`);
}

const publisher = flags.get("--signed");
if (publisher !== undefined) {
  if (process.platform !== "win32") throw new Error("--signed checks Authenticode on Windows only");
  const installer = flags.get("--installer");
  const files = [...signableFiles(dir), ...(installer ? [resolve(installer)] : [])];
  const records = powershell(
    '$paths = $env:CASHU_VERIFY_PATHS -split "`n"; Get-AuthenticodeSignature -LiteralPath $paths | ForEach-Object { [pscustomobject]@{ Path = $_.Path; Status = [string]$_.Status; Subject = $_.SignerCertificate.Subject; TimeStamper = [bool]$_.TimeStamperCertificate } } | ConvertTo-Json -Compress',
    { CASHU_VERIFY_PATHS: files.join("\n") },
  );
  if (records.length !== files.length)
    throw new Error(`Authenticode: ${records.length} results for ${files.length} files`);
  const problems = authenticodeProblems(records, publisher);
  if (problems.length > 0) throw new Error(`Authenticode:\n  ${problems.join("\n  ")}`);
  process.stdout.write(`Authenticode Valid, "${publisher}", timestamped: ${files.length} files\n`);
}
process.stdout.write(`Verified ${dir} (win32 x64)\n`);
