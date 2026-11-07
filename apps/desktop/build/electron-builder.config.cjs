const path = require("node:path");
const root = path.resolve(__dirname, "../../..");
const resources = path.join(root, "build/t46/resources");

module.exports = {
  appId: "io.utopiasoft.cashu",
  productName: "cashU",
  executableName: "cashU",
  directories: { output: path.join(root, "build/t46/electron-builder") },
  files: ["dist/*.js", "dist/preload.cjs", "package.json"],
  asar: true,
  extraResources: [
    ...["host.mjs", "shim.mjs", "notify-catalog-v1.json"].map((file) => ({
      from: path.join(resources, file), to: file,
    })),
    { from: path.join(resources, "native"), to: "native" },
    { from: path.join(resources, "node_modules"), to: "node_modules" },
    { from: path.join(resources, "skills"), to: "skills" },
    { from: path.join(resources, "connectors"), to: "connectors" },
    { from: path.join(resources, "renderer"), to: "renderer" },
  ],
  extraFiles: [
    { from: path.join(resources, "cashu-host-agent"), to: "MacOS/cashu-host-agent" },
    { from: path.join(root, "apps/desktop/service/io.utopiasoft.cashu.host.plist"),
      to: "Library/LaunchAgents/io.utopiasoft.cashu.host.plist" },
  ],
  mac: {
    identity: null,
    icon: path.join(root, "packaging/icon/cashU.icns"),
    category: "public.app-category.finance",
    target: ["dir"],
    hardenedRuntime: true,
    entitlements: path.join(root, "apps/desktop/build/entitlements.mac.plist"),
    entitlementsInherit: path.join(root, "apps/desktop/build/entitlements.mac.plist"),
    extendInfo: { CFBundleURLTypes: [{ CFBundleURLName: "cashU", CFBundleURLSchemes: ["cashu"] }] },
  },
  publish: null,
};
