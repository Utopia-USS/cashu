// The electron-builder config of one build flavor (packages/node-host/src/flavor.json): bundle ID,
// product name, URL scheme, icon, host agent plist and the flavor's own work dir. The flavor is
// sealed here: electron-builder writes the flavor's bundle ID into Contents/Info.plist, which the app
// reads at run time (packages/node-host/src/flavor.ts processFlavor). package-macos.mjs generates the
// flavor's resources (host agent plist, staging icon) into <buildDir>/resources before this runs.
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "../../..");
const table = JSON.parse(
  fs.readFileSync(path.join(root, "packages/node-host/src/flavor.json"), "utf8"),
);

/**
 * @param {string} id flavor id ("prod" | "staging")
 * @param {{ appVersion?: string | null, icon?: string }} [options]
 */
function builderConfig(id, options = {}) {
  if (!Object.hasOwn(table.flavors, id)) throw new Error(`Unknown flavor ${id}`);
  const flavor = table.flavors[id];
  const work = path.join(root, flavor.buildDir);
  const resources = path.join(work, "resources");
  const plist = `${flavor.hostAgentLabel}.plist`;
  return {
    appId: flavor.bundleId,
    productName: flavor.productName,
    // One executable name in every flavor: the identity checks pin Contents/MacOS/cashU.
    executableName: "cashU",
    directories: { output: path.join(work, "electron-builder") },
    // main.js and its chunks are self-contained rolldown bundles (only node:* and electron stay
    // external) and the preload needs only electron, so no node_modules goes into app.asar: the
    // workspace's dependency tree would add dead code and other-arch native binaries.
    files: ["dist/*.js", "dist/preload.cjs", "package.json", "!node_modules{,/**/*}"],
    asar: true,
    // No `npm rebuild` of the app's production dependencies: none goes into app.asar (see `files`),
    // the native modules are built and staged by package-macos.mjs, and no install script may run
    // during a release build (the CI release job has its temporary keychain unlocked by then).
    npmRebuild: false,
    extraResources: [
      ...["host.mjs", "shim.mjs", "notify-catalog-v1.json"].map((file) => ({
        from: path.join(resources, file),
        to: file,
      })),
      { from: path.join(resources, "native"), to: "native" },
      { from: path.join(resources, "node_modules"), to: "node_modules" },
      { from: path.join(resources, "skills"), to: "skills" },
      { from: path.join(resources, "connectors"), to: "connectors" },
      { from: path.join(resources, "renderer"), to: "renderer" },
    ],
    extraFiles: [
      { from: path.join(resources, "cashu-host-agent"), to: "MacOS/cashu-host-agent" },
      { from: path.join(resources, "launch-agents", plist), to: `Library/LaunchAgents/${plist}` },
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
    },
    ...(options.appVersion ? { extraMetadata: { version: options.appVersion } } : {}),
    publish: null,
  };
}

module.exports = { builderConfig };
