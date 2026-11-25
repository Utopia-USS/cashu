// The build flavors for the packaging scripts: the same table the app reads
// (packages/node-host/src/flavor.json, typed in packages/node-host/src/flavor.ts). `prod` is the
// released cashU.app; `staging` is the owner's local "cashU Staging" (ad hoc, never released).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const table = JSON.parse(readFileSync(join(root, "packages/node-host/src/flavor.json"), "utf8"));

export const FLAVOR_IDS = Object.freeze(Object.keys(table.flavors));

/** One flavor's row (plus its id); an unknown name throws. */
export function flavorById(id) {
  if (!Object.hasOwn(table.flavors, id))
    throw new Error(`Unknown flavor ${id} (${FLAVOR_IDS.join(", ")})`);
  return Object.freeze({ id, ...table.flavors[id] });
}

/** The flavor whose bundle ID this is, or null. */
export function flavorByBundleId(bundleId) {
  const id = FLAVOR_IDS.find((name) => table.flavors[name].bundleId === bundleId);
  return id === undefined ? null : flavorById(id);
}

/** Bundle-relative path of the flavor's host agent plist. */
export const agentPlistPath = (flavor) =>
  `Contents/Library/LaunchAgents/${flavor.hostAgentLabel}.plist`;

/** The .app name electron-builder produces. */
export const appName = (flavor) => `${flavor.productName}.app`;

/** The flavor's packaging work dir (absolute). */
export const buildDirOf = (flavor) => join(root, flavor.buildDir);

/** The bundled launchd plist of the host agent (fixed shape; only the label is the flavor's). */
export function hostAgentPlistXml(flavor) {
  if (!/^[A-Za-z0-9.-]+$/.test(flavor.hostAgentLabel)) throw new Error("Unexpected agent label");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${flavor.hostAgentLabel}</string>
  <key>BundleProgram</key>
  <string>Contents/MacOS/cashu-host-agent</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>7</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
</dict>
</plist>
`;
}
