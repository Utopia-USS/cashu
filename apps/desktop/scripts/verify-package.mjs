import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const app = realpathSync.native(resolve(process.argv[2] ?? ""));
const arch = process.argv[3] ?? process.arch;
if (!app.endsWith(".app") || !["arm64", "x64"].includes(arch))
  throw new Error("Expected a macOS app and architecture");
const xarch = arch === "x64" ? "x86_64" : "arm64";
const keyringBinding = `Contents/Resources/node_modules/@napi-rs/keyring-darwin-${arch}/keyring.darwin-${arch}.node`;
const contents = join(app, "Contents");
const info = join(contents, "Info.plist");
function command(name, args) {
  return execFileSync(name, args, { encoding: "utf8" }).trim();
}
function plist(key) {
  return command("plutil", ["-extract", key, "raw", info]);
}
if (plist("CFBundleIdentifier") !== "io.utopiasoft.cashu") throw new Error("Wrong app ID");
if (plist("CFBundleExecutable") !== "cashU") throw new Error("Wrong executable name");
const required = [
  "Contents/MacOS/cashU",
  "Contents/MacOS/cashu-host-agent",
  "Contents/Library/LaunchAgents/io.utopiasoft.cashu.host.plist",
  "Contents/Resources/host.mjs",
  "Contents/Resources/app.asar",
  "Contents/Resources/shim.mjs",
  "Contents/Resources/notify-catalog-v1.json",
  "Contents/Resources/native/CashUNotifications.node",
  "Contents/Resources/native/CashUHostService.node",
  "Contents/Resources/node_modules/@napi-rs/keyring/index.js",
  keyringBinding,
  "Contents/Resources/skills",
  "Contents/Resources/connectors",
  "Contents/Resources/skills/workspace-setup/SKILL.md",
  "Contents/Resources/connectors/README.md",
  "Contents/Resources/renderer/index.html",
];
for (const name of required) {
  const path = join(app, name);
  if (!existsSync(path)) throw new Error(`Missing ${name}`);
  const actual = realpathSync.native(path);
  const rel = relative(app, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Escaping ${name}`);
}
for (const name of ["Contents/MacOS/cashU", "Contents/MacOS/cashu-host-agent"]) {
  const path = join(app, name);
  if (!lstatSync(path).isFile() || (lstatSync(path).mode & 0o111) === 0)
    throw new Error(`Not executable: ${name}`);
  if (!command("lipo", ["-archs", path]).split(/\s+/).includes(xarch))
    throw new Error(`Wrong arch: ${name}`);
}
for (const name of ["CashUNotifications.node", "CashUHostService.node"]) {
  if (
    !command("lipo", ["-archs", join(contents, "Resources/native", name)])
      .split(/\s+/)
      .includes(xarch)
  )
    throw new Error(`Wrong addon arch: ${name}`);
}
if (
  !command("lipo", ["-archs", join(app, keyringBinding)])
    .split(/\s+/)
    .includes(xarch)
)
  throw new Error("Wrong keyring arch");
const manifest = JSON.parse(readFileSync(join(contents, "Resources/bundle-manifest.json"), "utf8"));
if (
  manifest.schema !== 1 ||
  !manifest.files ||
  typeof manifest.files !== "object" ||
  Object.keys(manifest.files).length < required.length
)
  throw new Error("Manifest schema");
for (const name of required) {
  if (name === "Contents/MacOS/cashU" || name.endsWith("/skills") || name.endsWith("/connectors"))
    continue;
  if (typeof manifest.files[name] !== "string") throw new Error(`Manifest missing: ${name}`);
}
for (const [name, expected] of Object.entries(manifest.files)) {
  const actual = createHash("sha256")
    .update(readFileSync(join(app, name)))
    .digest("hex");
  if (actual !== expected) throw new Error(`Manifest mismatch: ${name}`);
}
command("codesign", ["--verify", "--deep", "--strict", app]);
process.stdout.write(`Verified ${app} (${arch})\n`);
