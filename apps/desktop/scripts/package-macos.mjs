import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const build = join(root, "build", "t46");
const args = process.argv.slice(2);
const arch = args[0] ?? process.arch;
const pythonArg = args[1];
const withDmg = args.includes("--dmg");
const reuseDesktop = args.includes("--reuse-desktop");
if (!pythonArg || !["arm64", "x64"].includes(arch)) {
  throw new Error("usage: node package-macos.mjs <arm64|x64> <build/t46/.../dist/python>");
}
const python = realpathSync.native(resolve(pythonArg));
const rel = relative(build, python);
if (rel === ".." || rel.startsWith(`..${sep}`) || !existsSync(join(python, "cashu-python"))) {
  throw new Error("Python resource must be built inside ignored build/t46");
}
const resources = join(build, "resources");
if (python === resources || python.startsWith(resources + sep))
  throw new Error("Python source cannot be staging resources");
rmSync(resources, { recursive: true, force: true });
rmSync(join(build, "electron-builder"), { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
const env = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES: "false",
};
for (const key of Object.keys(env)) {
  if (
    /^(CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$|NOTARIZE_|ELECTRON_BUILDER_PUBLISH)/.test(key) &&
    key !== "CSC_IDENTITY_AUTO_DISCOVERY"
  )
    delete env[key];
}
function run(program, commandArgs, cwd = root) {
  const result = spawnSync(program, commandArgs, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${program} failed (${result.status ?? "signal"})`);
}
if (reuseDesktop) {
  if (
    !existsSync(join(root, "apps/desktop/dist/main.js")) ||
    !existsSync(join(root, "apps/desktop/dist/preload.cjs")) ||
    !existsSync(join(root, "src/cashu/api/webdist/assets/desktop/index.html"))
  )
    throw new Error("Built desktop inputs are missing");
} else run("pnpm", ["--filter", "@cashu/desktop", "build"]);
run("node", [join(root, "apps/desktop/scripts/build-host.mjs"), resources, arch]);
run("node", [join(root, "apps/desktop/scripts/build-native.mjs"), resources, arch]);
copyFileSync(
  join(root, "apps/desktop/resources/notify-catalog-v1.json"),
  join(resources, "notify-catalog-v1.json"),
);
cpSync(python, join(resources, "python"), { recursive: true, force: true, verbatimSymlinks: true });
const renderer = join(root, "src/cashu/api/webdist/assets/desktop");
if (!existsSync(join(renderer, "index.html"))) throw new Error("Native renderer build missing");
cpSync(renderer, join(resources, "renderer"), {
  recursive: true,
  force: true,
  filter: (name) => !name.endsWith(".map"),
});
function validateLinks(dir, rootDir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) validateLinks(path, rootDir);
    if (!entry.isSymbolicLink()) continue;
    const target = realpathSync.native(path);
    const rel = relative(rootDir, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error(`Resource symlink escapes staging: ${path}`);
  }
}
validateLinks(resources, resources);
run(
  "pnpm",
  [
    "exec",
    "electron-builder",
    "--mac",
    "dir",
    `--${arch}`,
    "--config",
    join(root, "apps/desktop/build/electron-builder.config.cjs"),
    "--publish",
    "never",
  ],
  join(root, "apps/desktop"),
);

const app = join(build, "electron-builder", arch === "arm64" ? "mac-arm64" : "mac", "cashU.app");
if (!existsSync(app)) throw new Error(`Builder app missing: ${app}`);
const contents = join(app, "Contents");
const entitlements = join(root, "apps/desktop/build/entitlements.mac.plist");
function machO(path) {
  if (!lstatSync(path).isFile()) return false;
  const fd = openSync(path, "r");
  const header = Buffer.alloc(4);
  try {
    readSync(fd, header, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  const magic = header.toString("hex");
  return [
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ].includes(magic);
}
function paths(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? paths(path) : entry.isFile() ? [path] : [];
  });
}
const nested = paths(contents).filter(
  (path) => path !== join(contents, "MacOS", "cashU") && machO(path),
);
for (const path of nested.sort((a, b) => b.length - a.length)) {
  run("codesign", [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    path,
  ]);
}
const manifestFiles = [
  ...paths(join(contents, "Resources")).map((path) => relative(app, path)),
  "Contents/MacOS/cashu-next-host-agent",
  "Contents/Library/LaunchAgents/io.utopiasoft.cashu.next.host.plist",
]
  .filter((path) => path !== "Contents/Resources/bundle-manifest.json")
  .sort();
const files = Object.fromEntries(
  manifestFiles.map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(join(app, name)))
      .digest("hex"),
  ]),
);
writeFileSync(
  join(contents, "Resources", "bundle-manifest.json"),
  `${JSON.stringify({ schema: 1, files }, null, 2)}\n`,
);
run("codesign", [
  "--force",
  "--sign",
  "-",
  "--options",
  "runtime",
  "--entitlements",
  entitlements,
  app,
]);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
run("node", [join(root, "apps/desktop/scripts/verify-package.mjs"), app, arch]);
const version = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")).version;
const zip = join(build, `cashU-${version}-mac-${arch}.zip`);
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
run("unzip", ["-tq", zip]);
if (withDmg) {
  run("hdiutil", [
    "create",
    "-srcfolder",
    app,
    "-format",
    "UDZO",
    "-volname",
    "cashU",
    join(build, `cashU-${version}-mac-${arch}.dmg`),
  ]);
}
process.stdout.write(`${app}\n`);
