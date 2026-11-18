// The Windows package identity as package-windows.mjs writes it, checked here and by the run-time
// verifier (packages/node-host bundleIdentity.ts with platform "win32"). Synthetic bytes only.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packagedVersion, readBundleIdentity } from "@cashu/node-host/bundle-identity";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_IDENTITY,
  appAsarVersion,
  appIdentityJson,
  authenticodeProblems,
  BUNDLE_MANIFEST,
  bundleManifest,
  checkWindowsInstall,
  compareInstalledTree,
  electronBuilderAsar,
  KEYRING_BINDING,
  manifestJson,
  signableFiles,
  subjectCommonName,
  trackedSymlinks,
  UNINSTALLER,
  windowsArtifactName,
} from "./windows-bundle.mjs";

const { WINDOWS_ARTIFACT_NAME } = createRequire(import.meta.url)("../build/flavor-config.cjs");
const BUNDLE_ID = "io.utopiasoft.cashu";
const VERSION = "1.2.3";
/**
 * The synthetic app.asar is its own package.json (a real archive is covered by one test below):
 * this reader stands in for @electron/asar extractFile.
 */
function readSyntheticAsar(archive, file) {
  if (file !== "package.json") throw new Error(`not in the archive: ${file}`);
  return readFileSync(archive);
}
const expected = { bundleId: BUNDLE_ID, version: VERSION, readAsarFile: readSyntheticAsar };
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "cashu-win-package-"));
  dirs.push(dir);
  return dir;
}
function write(root, path, content) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
/** What electron-builder --win dir leaves (synthetic), before the identity and the manifest. */
function unpackedPackage(appVersion = VERSION) {
  const dir = tempDir();
  for (const [path, content] of Object.entries({
    "cashU.exe": "MZ cashU",
    "ffmpeg.dll": "MZ codec",
    "locales/pl.pak": "pak",
    "resources/app.asar": JSON.stringify({ name: "cashu", version: appVersion }),
    "resources/host.mjs": "// host",
    "resources/shim.mjs": "// shim",
    "resources/notify-catalog-v1.json": "{}",
    "resources/skills/workspace-setup/SKILL.md": "skill",
    "resources/connectors/README.md": "catalog",
    "resources/renderer/index.html": "<html></html>",
    "resources/node_modules/@napi-rs/keyring/index.js": "module.exports = {}",
    [KEYRING_BINDING]: "MZ keyring",
  }))
    write(dir, path, content);
  return dir;
}
/** The sealing step of package-windows.mjs. */
function seal(dir, version = VERSION) {
  write(dir, APP_IDENTITY, appIdentityJson(BUNDLE_ID, version));
  write(dir, BUNDLE_MANIFEST, manifestJson(bundleManifest(dir)));
  return dir;
}

describe("Windows package identity", () => {
  it("writes an identity and a manifest the run time verifies", () => {
    const dir = seal(unpackedPackage());
    const manifest = checkWindowsInstall(dir, expected);
    expect(Object.keys(manifest.files)).toEqual([
      APP_IDENTITY,
      "resources/app.asar",
      "resources/connectors/README.md",
      "resources/host.mjs",
      KEYRING_BINDING,
      "resources/node_modules/@napi-rs/keyring/index.js",
      "resources/notify-catalog-v1.json",
      "resources/renderer/index.html",
      "resources/shim.mjs",
      "resources/skills/workspace-setup/SKILL.md",
    ]);
    expect(appIdentityJson(BUNDLE_ID, VERSION)).toBe(
      '{"schema":1,"bundleId":"io.utopiasoft.cashu","version":"1.2.3"}\n',
    );
    const identity = readBundleIdentity(dir, "win32");
    expect(identity.kind).toBe("present");
    expect(packagedVersion(dir, "win32")).toBe(VERSION);
  });

  it("refuses what the run time would refuse or what never ships on Windows", () => {
    const cases = [
      [
        "an unlisted resource",
        (dir) => write(dir, "resources/late.txt", "x"),
        /missing from the manifest/,
      ],
      ["elevate.exe", (dir) => write(dir, "resources/elevate.exe", "MZ"), /never ship/],
      [
        "a mac native addon",
        (dir) => write(dir, "resources/native/CashUNotifications.node", "x"),
        /never ship/,
      ],
      ["a test build marker", (dir) => write(dir, "resources/test-build.json", "{}"), /never ship/],
      ["an update feed", (dir) => write(dir, "resources/app-update.yml", "x"), /never ship/],
      [
        "a mac keyring",
        (dir) => write(dir, "resources/node_modules/@napi-rs/keyring-darwin-x64/k.node", "x"),
        /never ship/,
      ],
      ["the uninstaller", (dir) => write(dir, UNINSTALLER, "MZ"), /in the unpacked package/],
      [
        "a changed resource",
        (dir) => write(dir, "resources/host.mjs", "// changed"),
        /manifest mismatch resources\/host.mjs/,
      ],
      [
        "a missing keyring binding",
        (dir) => unlinkSync(join(dir, ...KEYRING_BINDING.split("/"))),
        /missing resources\/node_modules/,
      ],
      ["a non-PE executable", (dir) => write(dir, "cashU.exe", "ELF"), /not a PE image: cashU.exe/],
      [
        "a link",
        (dir) => symlinkSync("host.mjs", join(dir, "resources", "alias.mjs")),
        /links or special files/,
      ],
    ];
    for (const [label, mutate, error] of cases) {
      const dir = seal(unpackedPackage());
      mutate(dir);
      expect(() => checkWindowsInstall(dir, expected), label).toThrow(error);
    }
    // The run time agrees on the resource checks.
    const unlisted = seal(unpackedPackage());
    write(unlisted, "resources/late.txt", "x");
    expect(readBundleIdentity(unlisted, "win32").kind).toBe("invalid");
    const changed = seal(unpackedPackage());
    write(changed, "resources/host.mjs", "// changed");
    expect(readBundleIdentity(changed, "win32").kind).toBe("invalid");
  });

  it("checks the version and flavor sealed in app-identity.json", () => {
    const dir = seal(unpackedPackage("1.2.4"), "1.2.4");
    expect(() => checkWindowsInstall(dir, expected)).toThrow(/app-identity.json is not/);
    expect(() => checkWindowsInstall(dir, { ...expected, version: "1.2.4" })).not.toThrow();
    expect(() =>
      checkWindowsInstall(dir, {
        ...expected,
        bundleId: "io.utopiasoft.cashu.staging",
        version: "1.2.4",
      }),
    ).toThrow(/app-identity.json is not/);
    for (const [bundleId, version] of [
      ["io.utopiasoft.cashu", "1.2"],
      ["io.utopiasoft.cashu", "v1.2.3"],
      ["cashu", "1.2.3"],
    ])
      expect(() => appIdentityJson(bundleId, version)).toThrow(/Unexpected/);
  });

  it("refuses an app.asar whose version is not the identity's (Electron main's build id)", () => {
    const skewed = seal(unpackedPackage("1.2.4"));
    expect(() => checkWindowsInstall(skewed, expected)).toThrow(
      /app.asar package.json version 1.2.4, expected 1.2.3/,
    );
    // The run time alone cannot see the skew: the host reads only app-identity.json.
    expect(packagedVersion(skewed, "win32")).toBe(VERSION);
    const unreadable = unpackedPackage();
    write(unreadable, "resources/app.asar", "not json");
    seal(unreadable);
    expect(() => checkWindowsInstall(unreadable, expected)).toThrow(/no readable package.json/);
    const missing = unpackedPackage();
    write(missing, "resources/app.asar", JSON.stringify({ name: "cashu" }));
    seal(missing);
    expect(() => checkWindowsInstall(missing, expected)).toThrow(/package.json version undefined/);
  });

  it("reads app.asar with the @electron/asar electron-builder packs it with", async () => {
    const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const asar = electronBuilderAsar(desktopDir);
    const app = tempDir();
    write(app, "package.json", JSON.stringify({ name: "cashu", version: VERSION }));
    write(app, "dist/main.js", "// main");
    const install = tempDir();
    mkdirSync(join(install, "resources"));
    await asar.createPackage(app, join(install, "resources", "app.asar"));
    expect(appAsarVersion(install, asar.extractFile)).toBe(VERSION);
  });

  it("refuses to seal a package with links or without a required resource", () => {
    const linked = unpackedPackage();
    symlinkSync("index.html", join(linked, "resources", "renderer", "alias.html"));
    expect(() => bundleManifest(linked)).toThrow(/Links or special files/);
    const incomplete = unpackedPackage();
    unlinkSync(join(incomplete, "resources", "shim.mjs"));
    write(incomplete, APP_IDENTITY, appIdentityJson(BUNDLE_ID, VERSION));
    expect(() => bundleManifest(incomplete)).toThrow(/missing resources\/shim.mjs/);
  });

  it("installs the unpacked bytes plus the uninstaller, with a build identity stable per installer", () => {
    const unpacked = seal(unpackedPackage());
    const install = () => {
      const dir = tempDir();
      cpSync(unpacked, dir, { recursive: true });
      write(dir, UNINSTALLER, "MZ uninstaller built once per installer");
      return dir;
    };
    const first = install();
    const second = install();
    expect(compareInstalledTree(unpacked, first)).toEqual({
      missing: [],
      extra: [],
      changed: [],
      other: [],
    });
    expect(() => checkWindowsInstall(first, { ...expected, installed: true })).not.toThrow();
    expect(() => checkWindowsInstall(unpacked, { ...expected, installed: true })).toThrow(
      /missing Uninstall cashU.exe/,
    );
    // The run-time content digest covers the whole install dir, the uninstaller included: equal for
    // two installs of one installer, different from the unpacked dir.
    const a = readBundleIdentity(first, "win32");
    const b = readBundleIdentity(second, "win32");
    const bare = readBundleIdentity(unpacked, "win32");
    expect(a.kind === "present" && b.kind === "present" && bare.kind === "present").toBe(true);
    expect(a.contentDigest).toBe(b.contentDigest);
    expect(a.contentDigest).not.toBe(bare.contentDigest);

    const tampered = install();
    write(tampered, "resources/elevate.exe", "MZ");
    write(tampered, "ffmpeg.dll", "MZ other");
    unlinkSync(join(tampered, "locales", "pl.pak"));
    expect(compareInstalledTree(unpacked, tampered)).toEqual({
      missing: ["locales/pl.pak"],
      extra: ["resources/elevate.exe"],
      changed: ["ffmpeg.dll"],
      other: [],
    });
    expect(compareInstalledTree(unpacked, unpacked).missing).toEqual([UNINSTALLER]);
  });

  it("lists the files Authenticode must cover", () => {
    const dir = seal(unpackedPackage());
    expect(
      signableFiles(dir).map((path) =>
        path
          .slice(dir.length + 1)
          .split(/[\\/]/)
          .join("/"),
      ),
    ).toEqual(["cashU.exe", "ffmpeg.dll", KEYRING_BINDING]);
  });
});

describe("Windows packaging helpers", () => {
  it("names the installer like the builder config", () => {
    expect(windowsArtifactName("0.5.0")).toBe("cashU-0.5.0-win-x64.exe");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the electron-builder macro itself.
    expect(WINDOWS_ARTIFACT_NAME.replace("${version}", "0.5.0")).toBe(windowsArtifactName("0.5.0"));
    expect(() => windowsArtifactName("0.5")).toThrow(/Unexpected version/);
  });

  it("finds git symlinks in git ls-files -s -z output", () => {
    const output = [
      "100644 916aa3ea7593ac0658fbd7ba9e561cd0c679 0\t.claude/skills/a/SKILL.md",
      "120000 454b8427cd757f30dc7fdb9a325d19c39977 0\tconnectors/link name",
      "100755 916aa3ea7593ac0658fbd7ba9e561cd0c679 0\tconnectors/run.sh",
      "",
    ].join("\0");
    expect(trackedSymlinks(output)).toEqual(["connectors/link name"]);
    expect(trackedSymlinks("")).toEqual([]);
    expect(() => trackedSymlinks("garbage\0")).toThrow(/Unexpected git ls-files entry/);
  });

  it("checks Authenticode records against the publisher", () => {
    expect(subjectCommonName("CN=Example Sp. z o.o., O=Example Sp. z o.o., C=PL")).toBe(
      "Example Sp. z o.o.",
    );
    expect(subjectCommonName('CN="Example, Inc.", O=Example')).toBe("Example, Inc.");
    expect(subjectCommonName("O=Example")).toBeNull();
    const ok = { Status: "Valid", Subject: "CN=Example Sp. z o.o., C=PL", TimeStamper: true };
    expect(
      authenticodeProblems(
        [
          { Path: "a.exe", ...ok },
          { Path: "b.dll", ...ok, Status: "NotSigned", Subject: null },
          { Path: "c.node", ...ok, Subject: "CN=Someone Else" },
          { Path: "d.exe", ...ok, TimeStamper: false },
        ],
        "Example Sp. z o.o.",
      ),
    ).toEqual([
      "b.dll: status NotSigned",
      "c.node: signed by CN=Someone Else",
      "d.exe: no timestamp",
    ]);
  });
});
