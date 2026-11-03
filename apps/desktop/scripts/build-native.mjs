import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.argv[2] ?? join(root, "build", "t46", "resources"));
const arch = process.argv[3] ?? process.arch;
if (!out.startsWith(join(root, "build", "t46") + "/"))
  throw new Error("Output must be in build/t46");
if (arch !== "arm64" && arch !== "x64") throw new Error("Expected arm64 or x64");
const clang = execFileSync("xcrun", ["--find", "clang++"], { encoding: "utf8" }).trim();
const sdk = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
  encoding: "utf8",
}).trim();
const swift = execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" }).trim();
const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
const include = resolve(dirname(node), "../include/node");
const clangArch = arch === "x64" ? "x86_64" : "arm64";
const native = join(out, "native");
mkdirSync(native, { recursive: true });
for (const [name, frameworks] of [
  ["CashUNotifications", ["Foundation", "UserNotifications", "CoreFoundation"]],
  ["CashUHostService", ["Foundation", "ServiceManagement"]],
]) {
  execFileSync(
    clang,
    [
      "-std=c++17",
      "-fobjc-arc",
      "-x",
      "objective-c++",
      "-dynamiclib",
      "-arch",
      clangArch,
      "-isysroot",
      sdk,
      "-mmacosx-version-min=13.0",
      "-I",
      include,
      "-undefined",
      "dynamic_lookup",
      ...frameworks.flatMap((framework) => ["-framework", framework]),
      join(root, "apps", "desktop", "native", `${name}.mm`),
      "-o",
      join(native, `${name}.node`),
    ],
    { stdio: "inherit" },
  );
}
execFileSync(
  swift,
  [
    "-target",
    `${clangArch}-apple-macosx13.0`,
    "-sdk",
    sdk,
    "-O",
    join(root, "apps", "desktop", "service", "CashUHostAgent.swift"),
    "-o",
    join(out, "cashu-next-host-agent"),
  ],
  { stdio: "inherit" },
);
