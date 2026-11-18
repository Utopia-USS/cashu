// Bundles host.mjs and shim.mjs (rolldown) and stages the OS keyring binding next to them.
//
//   node apps/desktop/scripts/build-host.mjs <out dir> [arm64|x64] [darwin|win32]
//
// The platform (default: this process's) picks the @napi-rs/keyring native package: the macOS one
// per arch (keyring-darwin-<arch>), the Windows MSVC one (x64 only). pnpm installs only the current
// OS's packages (pnpm-workspace.yaml supportedArchitectures), so each platform is built on its own OS.
import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { buildDirOf, FLAVOR_IDS, flavorById } from "./flavor.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.argv[2] ?? join(root, "build", "t46", "resources"));
const arch = process.argv[3] ?? process.arch;
const platform = process.argv[4] ?? process.platform;
if (arch !== "arm64" && arch !== "x64") throw new Error("Expected arm64 or x64");
/** The keyring binding package of each packaged platform and arch. */
const KEYRING_PACKAGES = {
  darwin: { arm64: "keyring-darwin-arm64", x64: "keyring-darwin-x64" },
  win32: { x64: "keyring-win32-x64-msvc" },
};
const nativePackage = KEYRING_PACKAGES[platform]?.[arch];
if (!nativePackage) throw new Error(`No packaged keyring binding for ${platform} ${arch}`);
// host.mjs and shim.mjs are flavor-free (the flavor is read from the bundle at run time): any
// flavor's packaging work dir is a valid output.
if (!FLAVOR_IDS.some((id) => out.startsWith(`${buildDirOf(flavorById(id))}${sep}`)))
  throw new Error("Output must be in a flavor's build dir (build/t46, build/staging)");
mkdirSync(out, { recursive: true });
// Keep the actual OS keyring binding next to host.mjs. Node's ESM resolver finds it from
// <resources>/node_modules; Rolldown cannot inline a .node file and no fake binding is shipped.
const hostRequire = createRequire(join(root, "packages", "node-host", "package.json"));
const keyringEntry = hostRequire.resolve("@napi-rs/keyring");
const nativeRequire = createRequire(keyringEntry);
let nativeEntry;
try {
  nativeEntry = nativeRequire.resolve(`@napi-rs/${nativePackage}`);
} catch {
  throw new Error(
    `@napi-rs/${nativePackage} is not installed: package ${platform} on ${platform} (pnpm installs only the current OS's bindings)`,
  );
}
for (const [name, source] of [
  ["keyring", dirname(keyringEntry)],
  [nativePackage, dirname(nativeEntry)],
]) {
  cpSync(source, join(out, "node_modules", "@napi-rs", name), {
    recursive: true,
    dereference: true,
  });
}
for (const [name, input] of [
  ["host", "apps/host/src/cli.ts"],
  ["shim", "apps/cli/src/index.ts"],
]) {
  await build({
    input: join(root, input),
    platform: "node",
    // dbus-next calls x11 only for Linux window-selection bus discovery, from the Linux notifier.
    // The macOS and Windows hosts never load that notifier (Windows has the notification stub);
    // Linux packaging owns its own platform dependency graph.
    external: [/^node:/, /^electron(\/.*)?$/, /^@napi-rs\/keyring(?:\/.*)?$/, /^x11$/],
    resolve: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
    output: {
      file: join(out, `${name}.mjs`),
      format: "esm",
      codeSplitting: false,
      sourcemap: false,
    },
    logLevel: "warn",
  });
}
