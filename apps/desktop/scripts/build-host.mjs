import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.argv[2] ?? join(root, "build", "t46", "resources"));
const arch = process.argv[3] ?? process.arch;
if (arch !== "arm64" && arch !== "x64") throw new Error("Expected arm64 or x64");
if (!out.startsWith(join(root, "build", "t46") + "/"))
  throw new Error("Output must be in build/t46");
mkdirSync(out, { recursive: true });
// Keep the actual OS keyring binding next to host.mjs. Node's ESM resolver finds it from
// Resources/node_modules; Rolldown cannot inline a .node file and no fake binding is shipped.
const hostRequire = createRequire(join(root, "packages", "node-host", "package.json"));
const keyringEntry = hostRequire.resolve("@napi-rs/keyring");
const nativeRequire = createRequire(keyringEntry);
const nativePackage = `keyring-darwin-${arch}`;
const nativeEntry = nativeRequire.resolve(`@napi-rs/${nativePackage}`);
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
    // dbus-next calls x11 only for Linux window-selection bus discovery. The macOS host never
    // enters that branch; Linux packaging owns its own platform dependency graph.
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
