// Builds the Windows x64 installer of cashU (contracts C5 and C8 of the Windows port).
//
//   node apps/desktop/scripts/package-windows.mjs x64 [--out <dir>] [--reuse-desktop] [--sign azure]
//
// Windows only (it refuses any other OS): pnpm installs only this OS's keyring binding, NSIS builds
// its uninstaller by running it, and Authenticode is checked with PowerShell. Prod flavor only
// (--flavor prod is accepted, anything else refused; staging is the owner's local Mac app).
//
// Steps: desktop build (unless --reuse-desktop) -> build-host.mjs (win32 x64 keyring binding) ->
// staged resources (notify catalog, skills, connectors, renderer; a git symlink under skills or
// connectors is refused, since a Windows checkout turns it into a text file) -> electron-builder
// --win dir (signs cashU.exe, the Electron DLLs and the keyring addon with --sign azure) ->
// resources\app-identity.json and resources\bundle-manifest.json written into win-unpacked ->
// verify-package-windows.mjs -> electron-builder --win nsis --prepackaged win-unpacked (signs the
// uninstaller and the installer with --sign azure) -> the unpacked dir is verified again (nothing may
// touch it after the manifest) -> cashU-<version>-win-x64.exe copied to --out (default build/t46).
// The run-time build id hashes the whole install dir: the installer installs the unpacked bytes
// plus "Uninstall cashU.exe", identical on every install of one installer.
//
// Unsigned (default): electron-builder signs nothing (win.signExecutable false) and runs without
// CSC_* / WIN_CSC_* / AZURE_* in its environment, so nothing signs by discovery.
// Every other child (the desktop build, build-host.mjs, git, the verifier) runs with no AZURE_* or
// CASHU_AZURE_* name at all (`buildEnv`): only the two electron-builder runs of an Azure build see
// the credentials, never the bundler, its plugins or an install-time script.
// --sign azure: Azure Trusted Signing through electron-builder's win.azureSignOptions. Settings:
// CASHU_AZURE_ENDPOINT, CASHU_AZURE_ACCOUNT, CASHU_AZURE_CERT_PROFILE, CASHU_AZURE_PUBLISHER (the
// certificate's subject common name, checked on every signed file). Credentials, read only by the
// TrustedSigning PowerShell module and never printed: AZURE_TENANT_ID, AZURE_CLIENT_ID,
// AZURE_CLIENT_SECRET. A missing name fails before anything is built.
//
// Last line before the dir: `release-summary {json}` (version, arch, platform, mode, artifact).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDirOf, flavorById } from "./flavor.mjs";
import {
  assertWindowsHost,
  azureSigningFromEnv,
  buildEnv,
  builderEnv,
  parseWindowsPackageArgs,
  signingLabel,
} from "./package-windows-args.mjs";
import { checkedRendererArtifact, rendererArtifactRoot } from "./renderer-artifact.mjs";
import {
  APP_IDENTITY,
  appIdentityJson,
  BUNDLE_MANIFEST,
  bundleManifest,
  installEntries,
  manifestJson,
  trackedSymlinks,
  WINDOWS_EXECUTABLE,
  windowsArtifactName,
} from "./windows-bundle.mjs";

assertWindowsHost(process.platform);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const options = parseWindowsPackageArgs(process.argv.slice(2));
const flavor = flavorById(options.flavor);
const build = buildDirOf(flavor);
const out = options.out ?? build;
const azure = options.sign === "azure" ? azureSigningFromEnv(process.env) : null;
// electron-builder's environment (the Azure credentials of an Azure build) and everyone else's.
const signingEnv = builderEnv(process.env, options.sign);
const env = buildEnv(process.env);
const version = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).version;
process.stdout.write(
  `flavor ${flavor.id}: ${flavor.productName} (${flavor.bundleId}) ${version}\n`,
);
process.stdout.write(`signing: ${signingLabel(azure)}\n`);

function run(program, args, cwd = root, childEnv = env) {
  const result = spawnSync(program, args, { cwd, env: childEnv, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? "signal"})`);
}
// electron-builder through its own CLI script on this Node (no .cmd shim, no shell).
const electronBuilder = createRequire(join(root, "apps/desktop/package.json")).resolve(
  "electron-builder/cli.js",
);
function builder(args) {
  run(
    process.execPath,
    [electronBuilder, ...args, "--publish", "never"],
    join(root, "apps/desktop"),
    signingEnv,
  );
}

// A git symlink under the shipped trees arrives as a text file on a Windows checkout
// (core.symlinks=false): refuse it before building rather than ship a broken skill or connector.
const lsFiles = spawnSync("git", ["ls-files", "-s", "-z", "--", ".claude/skills", "connectors"], {
  cwd: root,
  env,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (lsFiles.status !== 0)
  throw new Error("package-windows.mjs needs a git checkout (to find symlinks git materialized)");
const links = trackedSymlinks(lsFiles.stdout);
if (links.length > 0)
  throw new Error(
    `Symlinks under .claude/skills or connectors cannot ship on Windows (a checkout turns them into text files): ${links.join(", ")}. Replace each with a real file.`,
  );

const resources = join(build, "resources");
const builderOut = join(build, "electron-builder");
rmSync(resources, { recursive: true, force: true });
rmSync(builderOut, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
mkdirSync(out, { recursive: true });

if (options.reuseDesktop) {
  if (
    !existsSync(join(root, "apps/desktop/dist/main.js")) ||
    !existsSync(join(root, "apps/desktop/dist/preload.cjs")) ||
    !existsSync(join(rendererArtifactRoot(root), "index.html"))
  )
    throw new Error("Built desktop inputs are missing");
} else {
  // pnpm is a .cmd shim on Windows, which only a shell runs; the command line is fixed.
  const result = spawnSync("pnpm --filter @cashu/desktop build", {
    cwd: root,
    env,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) throw new Error(`desktop build failed (${result.status ?? "signal"})`);
}
run(process.execPath, [
  join(root, "apps/desktop/scripts/build-host.mjs"),
  resources,
  options.arch,
  "win32",
]);
copyFileSync(
  join(root, "apps/desktop/resources/notify-catalog-v1.json"),
  join(resources, "notify-catalog-v1.json"),
);
for (const [name, source] of [
  ["skills", join(root, ".claude", "skills")],
  ["connectors", join(root, "connectors")],
])
  cpSync(source, join(resources, name), { recursive: true, force: true, verbatimSymlinks: true });
cpSync(checkedRendererArtifact(root), join(resources, "renderer"), {
  recursive: true,
  force: true,
  filter: (name) => !name.endsWith(".map"),
});
// Nothing but regular files and directories may be staged: the installer carries no links, and the
// run time refuses junctions.
const staged = installEntries(resources);
if (staged.other.length > 0)
  throw new Error(`Links or special files in the staged resources: ${staged.other.join(", ")}`);

// The Windows builder config: flavor-config.cjs with the Windows metadata and, with --sign azure,
// the public Trusted Signing settings (the credentials stay in the environment).
const config = join(build, "electron-builder.win.generated.cjs");
writeFileSync(
  config,
  `// Generated by package-windows.mjs; never committed.\n` +
    `module.exports = require(${JSON.stringify(join(root, "apps/desktop/build/flavor-config.cjs"))}).builderConfig(${JSON.stringify(flavor.id)}, ${JSON.stringify({ target: "win", azure })});\n`,
);
builder(["--win", "dir", `--${options.arch}`, "--config", config]);

const unpacked = join(builderOut, "win-unpacked");
if (!existsSync(join(unpacked, WINDOWS_EXECUTABLE)))
  throw new Error(`Builder output missing: ${join(unpacked, WINDOWS_EXECUTABLE)}`);
// The identity record, then the manifest over every resource file (the record included). Both are
// written after electron-builder signed the binaries and before the installer packs the dir.
writeFileSync(
  join(unpacked, ...APP_IDENTITY.split("/")),
  appIdentityJson(flavor.bundleId, version),
);
writeFileSync(
  join(unpacked, ...BUNDLE_MANIFEST.split("/")),
  manifestJson(bundleManifest(unpacked)),
);
const verify = join(root, "apps/desktop/scripts/verify-package-windows.mjs");
const signed = azure ? ["--signed", azure.publisher] : [];
run(process.execPath, [verify, unpacked, "--version", version, ...signed]);

builder(["--win", "nsis", `--${options.arch}`, "--config", config, "--prepackaged", unpacked]);
const name = windowsArtifactName(version);
const installer = join(builderOut, name);
if (!existsSync(installer)) throw new Error(`Installer missing: ${installer}`);
// The installer step must not have touched the sealed dir (an elevate.exe or a re-signed binary
// would make every install fail its identity check): verify it again, with the installer's signature.
run(process.execPath, [
  verify,
  unpacked,
  "--version",
  version,
  ...signed,
  ...(azure ? ["--installer", installer] : []),
]);
const artifact = join(out, name);
if (resolve(artifact) !== resolve(installer)) copyFileSync(installer, artifact);
const summary = {
  version,
  arch: options.arch,
  platform: "win32",
  flavor: flavor.id,
  mode: azure ? "azure" : "unsigned",
  out,
  artifacts: [
    {
      name,
      bytes: statSync(artifact).size,
      sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"),
    },
  ],
};
process.stdout.write(`release-summary ${JSON.stringify(summary)}\n`);
process.stdout.write(`${unpacked}\n`);
