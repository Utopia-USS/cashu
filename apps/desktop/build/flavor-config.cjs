// The electron-builder config of one build flavor (packages/node-host/src/flavor.json): bundle ID,
// product name, URL scheme, icon, host agent plist and the flavor's own work dir. The flavor is
// sealed here: electron-builder writes the flavor's bundle ID into Contents/Info.plist, which the app
// reads at run time (packages/node-host/src/flavor.ts processFlavor). package-macos.mjs generates the
// flavor's resources (host agent plist, staging icon) into <buildDir>/resources before this runs.
//
// One config serves both platforms. The resources every platform ships sit at the top level; the
// macOS-only pieces (the native addons, the host agent and its launch agent plist) sit under `mac`,
// which electron-builder appends to the top-level extraResources / extraFiles for a --mac build only,
// so a macOS bundle keeps exactly the layout it had before Windows existed. `win` and `nsis` describe
// the Windows x64 installer that package-windows.mjs builds (prod flavor only): a per-user NSIS
// install without elevation that never deletes user data, unsigned unless the packaging script passes
// Azure Trusted Signing options (`options.azure`), in which case every executable, DLL and .node
// addon is signed and an unsigned file fails the build.
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "../../..");
const table = JSON.parse(
  fs.readFileSync(path.join(root, "packages/node-host/src/flavor.json"), "utf8"),
);

/** The resource files every platform's package carries (relative to the staged resources dir). */
const SHARED_RESOURCE_FILES = ["host.mjs", "shim.mjs", "notify-catalog-v1.json"];
const SHARED_RESOURCE_DIRS = ["node_modules", "skills", "connectors", "renderer"];
/** The Windows installer's name; the release and the update feed (later) rely on it. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: an electron-builder macro, expanded by it.
const WINDOWS_ARTIFACT_NAME = "cashU-${version}-win-x64.exe";
/**
 * The package name a Windows build carries in app.asar. A per-user one-click NSIS install names its
 * folder (%LOCALAPPDATA%\Programs\<name>) and its updater cache after it; the workspace name
 * "@cashu/desktop" would become "@cashudesktop". The running app never reads it (main.ts sets the
 * app name and the user data path from the flavor).
 */
const WINDOWS_PACKAGE_NAME = "cashu";
/** NSIS macros the Windows installer adds to electron-builder's templates (customUnInstall). */
const WINDOWS_NSIS_INCLUDE = path.join(__dirname, "windows-uninstall.nsh");

/**
 * @typedef {{ endpoint: string, account: string, certificateProfile: string, publisher: string }} AzureSigning
 * @param {string} id flavor id ("prod" | "staging")
 * @param {{ appVersion?: string | null, icon?: string, target?: "mac" | "win", azure?: AzureSigning | null }} [options]
 *   target: the platform being built (default "mac"); "win" adds the Windows-only package metadata.
 *   azure: Azure Trusted Signing for a Windows build (the client secret stays in the environment).
 */
function builderConfig(id, options = {}) {
  if (!Object.hasOwn(table.flavors, id)) throw new Error(`Unknown flavor ${id}`);
  const target = options.target ?? "mac";
  if (target !== "mac" && target !== "win") throw new Error(`Unknown target ${target}`);
  if (target === "win" && id !== "prod")
    throw new Error("Only the prod flavor is packaged for Windows");
  if (options.azure && target !== "win") throw new Error("Azure signing is for Windows builds");
  const flavor = table.flavors[id];
  const work = path.join(root, flavor.buildDir);
  const resources = path.join(work, "resources");
  const plist = `${flavor.hostAgentLabel}.plist`;
  const metadata = {
    ...(target === "win" ? { name: WINDOWS_PACKAGE_NAME } : {}),
    ...(options.appVersion ? { version: options.appVersion } : {}),
  };
  return {
    appId: flavor.bundleId,
    productName: flavor.productName,
    // One executable name in every flavor and platform: the identity checks pin
    // Contents/MacOS/cashU on macOS and <install>\cashU.exe on Windows.
    executableName: "cashU",
    directories: { output: path.join(work, "electron-builder") },
    // main.js and its chunks are self-contained rolldown bundles (only node:* and electron stay
    // external) and the preload needs only electron, so no node_modules goes into app.asar: the
    // workspace's dependency tree would add dead code and other-arch native binaries.
    files: ["dist/*.js", "dist/preload.cjs", "package.json", "!node_modules{,/**/*}"],
    asar: true,
    // No `npm rebuild` of the app's production dependencies: none goes into app.asar (see `files`),
    // the native modules are built and staged by the packaging scripts, and no install script may run
    // during a release build (the CI release job has its temporary keychain unlocked by then).
    npmRebuild: false,
    extraResources: [
      ...SHARED_RESOURCE_FILES.map((file) => ({ from: path.join(resources, file), to: file })),
      ...SHARED_RESOURCE_DIRS.map((dir) => ({ from: path.join(resources, dir), to: dir })),
    ],
    mac: {
      // Never sign here: scripts/package-macos.mjs is the only signer (ad hoc, or Developer ID with
      // --sign), inside out, after bundle-manifest.json. hardenedRuntime / entitlements below are inert.
      identity: null,
      icon: options.icon ?? path.join(root, "packaging/icon/cashU.icns"),
      category: "public.app-category.finance",
      target: ["dir"],
      hardenedRuntime: true,
      entitlements: path.join(root, "apps/desktop/build/entitlements.mac.plist"),
      entitlementsInherit: path.join(root, "apps/desktop/build/entitlements.mac.plist"),
      extendInfo: {
        CFBundleURLTypes: [
          { CFBundleURLName: flavor.productName, CFBundleURLSchemes: [flavor.urlScheme] },
        ],
      },
      // macOS only: the notification and host service addons, the daily host agent and its plist.
      extraResources: [{ from: path.join(resources, "native"), to: "native" }],
      extraFiles: [
        { from: path.join(resources, "cashu-host-agent"), to: "MacOS/cashu-host-agent" },
        { from: path.join(resources, "launch-agents", plist), to: `Library/LaunchAgents/${plist}` },
      ],
    },
    win: windowsConfig(options.azure ?? null),
    nsis: {
      // Per-user, no elevation, no installer UI: %LOCALAPPDATA%\Programs\cashu, like the vault in
      // %LOCALAPPDATA%\cashU it never leaves the user's own profile.
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      // elevate.exe is only for per-machine installs, and electron-builder injects it into the
      // installer's payload (and the unpacked dir) after bundle-manifest.json is written: the installed
      // resources would carry a file the manifest does not list, and the identity check refuses that.
      packElevateHelper: false,
      // Never delete user data: the uninstaller keeps every data dir (the vault lives in
      // %LOCALAPPDATA%\cashU, which no uninstaller path touches).
      deleteAppDataOnUninstall: false,
      // The uninstall step that removes the per-user `cashu://` registration the app writes at
      // start, when it still opens this install. An explicit include under a name electron-builder
      // never picks up by itself: it changes the NSIS script only, never what gets installed.
      include: WINDOWS_NSIS_INCLUDE,
      // No update feed on Windows yet (C7): no differential package or blockmap.
      differentialPackage: false,
      runAfterFinish: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      menuCategory: false,
      // Stable names across versions: shortcuts and the Apps & features entry never carry a version.
      shortcutName: flavor.productName,
      uninstallDisplayName: flavor.productName,
      artifactName: WINDOWS_ARTIFACT_NAME,
    },
    ...(Object.keys(metadata).length > 0 ? { extraMetadata: metadata } : {}),
    publish: null,
  };
}

/** The Windows section: unsigned (nothing is signed, whatever the environment holds) or Azure. */
function windowsConfig(azure) {
  const base = {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: path.join(root, "packaging/icon/cashu-1024.png"),
    requestedExecutionLevel: "asInvoker",
    // Resource editing stays on (icon, version info of cashU.exe).
    signAndEditExecutable: true,
  };
  if (!azure) return { ...base, signExecutable: false };
  for (const key of ["endpoint", "account", "certificateProfile", "publisher"])
    if (typeof azure[key] !== "string" || azure[key] === "")
      throw new Error(`Azure signing needs ${key}`);
  return {
    ...base,
    signExecutable: true,
    // electron-builder signs every .exe it builds or copies (cashU.exe, the installer, the
    // uninstaller); the Electron DLLs next to cashU.exe and the keyring .node addon are signed too,
    // so Smart App Control and WDAC policies see one publisher on every binary the app loads.
    signExts: [".dll", ".node"],
    forceCodeSigning: true,
    azureSignOptions: {
      publisherName: azure.publisher,
      endpoint: azure.endpoint,
      codeSigningAccountName: azure.account,
      certificateProfileName: azure.certificateProfile,
    },
  };
}

module.exports = {
  builderConfig,
  WINDOWS_ARTIFACT_NAME,
  WINDOWS_NSIS_INCLUDE,
  WINDOWS_PACKAGE_NAME,
};
