import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appBundleName,
  bundleFlavor,
  dataDirName,
  executableFlavor,
  FLAVOR_IDS,
  FLAVORS,
  type Flavor,
  flavorForBundleId,
  hostAgentPlist,
  keychainService,
  legacyWorkspacesRoot,
  mcpServerName,
  packagedBundleOf,
  processFlavor,
  readAppIdentity,
  WINDOWS_APP_IDENTITY,
  WINDOWS_EXECUTABLE,
  workspacesRoot,
} from "./flavor.js";
import table from "./flavor.json" with { type: "json" };
import { linkFile } from "./testing/links.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const prod = FLAVORS.prod;
const staging = FLAVORS.staging;
const KINDS = ["vault", "banking", "classifier", "connectors"] as const;
const HASH = "ab".repeat(32);

/**
 * How two flavors' values of one table field must differ. Every field of the table needs an entry
 * here, so a field added later is covered (or the guard test fails until someone decides).
 */
type Rule = (a: Flavor, b: Flavor) => void;
const different =
  (pick: (f: Flavor) => string | number): Rule =>
  (a, b) =>
    expect(String(pick(a)).toLowerCase()).not.toBe(String(pick(b)).toLowerCase());
/** Dotted identifiers (launchd labels): neither is the other or a dotted ancestor of it. */
const dotted =
  (pick: (f: Flavor) => string): Rule =>
  (a, b) => {
    expect(pick(a)).not.toBe(pick(b));
    expect(pick(b).startsWith(`${pick(a)}.`)).toBe(false);
  };
const RULES: Record<keyof Omit<Flavor, "id">, Rule> = {
  bundleId: different((f) => f.bundleId),
  productName: different((f) => f.productName),
  dataDirName: (a, b) => {
    for (const platform of ["darwin", "linux", "win32"] as const)
      different((f) => dataDirName(f, platform))(a, b);
  },
  workspacesDirName: different((f) => f.workspacesDirName),
  hostAgentLabel: dotted((f) => f.hostAgentLabel),
  keychainPrefix: (a, b) => {
    // No service of one flavor is a service of the other, for any kind and any hash.
    const pattern = (f: Flavor) =>
      new RegExp(
        `^${f.keychainPrefix.replaceAll(".", "\\.")}\\.(${KINDS.join("|")})\\.v1\\.[0-9a-f]{64}$`,
      );
    for (const kind of KINDS) {
      expect(pattern(b).test(keychainService(a, kind, HASH))).toBe(false);
      expect(pattern(a).test(keychainService(b, kind, HASH))).toBe(false);
    }
  },
  urlScheme: different((f) => f.urlScheme),
  mcpServerPrefix: different((f) => f.mcpServerPrefix),
  updateFeed: () => {},
  inheritsPythonInstall: () => {},
  iconBadge: () => {},
  buildDir: (a, b) => {
    expect(a.buildDir).not.toBe(b.buildDir);
    expect(b.buildDir.startsWith(`${a.buildDir}/`)).toBe(false);
  },
  artifactPrefix: (a, b) => {
    const artifact = /^(.+)-\d+\.\d+\.\d+-mac-(arm64|x64)\.(zip|dmg)$/;
    expect(artifact.exec(`${a.artifactPrefix}-0.5.0-mac-arm64.zip`)?.[1]).not.toBe(
      b.artifactPrefix,
    );
  },
};

describe("build flavors", () => {
  it("keeps every prod name exactly as released", () => {
    expect(prod).toEqual({
      id: "prod",
      bundleId: "io.utopiasoft.cashu",
      productName: "cashU",
      dataDirName: { darwin: "cashU", linux: "cashu", win32: "cashU" },
      workspacesDirName: "cashU",
      hostAgentLabel: "io.utopiasoft.cashu.host",
      keychainPrefix: "cashu",
      urlScheme: "cashu",
      mcpServerPrefix: "cashu",
      updateFeed: true,
      inheritsPythonInstall: true,
      iconBadge: null,
      buildDir: "build/t46",
      artifactPrefix: "cashU",
    });
    expect(keychainService(prod, "vault", HASH)).toBe(`cashu.vault.v1.${HASH}`);
    expect(hostAgentPlist(prod)).toBe("io.utopiasoft.cashu.host.plist");
    expect(mcpServerName(prod, "jan")).toBe("cashu-jan");
    expect(workspacesRoot(prod, "/Users/x")).toBe(join("/Users/x", "cashU"));
    expect(legacyWorkspacesRoot(prod, "/Users/x")).toBe(join("/Users/x", "Documents", "cashU"));
    expect(appBundleName(prod)).toBe("cashU.app");
  });

  it("names the staging app as the owner decided", () => {
    expect(staging.bundleId).toBe("io.utopiasoft.cashu.staging");
    expect(appBundleName(staging)).toBe("cashU Staging.app");
    expect(dataDirName(staging, "darwin")).toBe("cashU Staging");
    expect(dataDirName(staging, "win32")).toBe("cashU Staging");
    expect(workspacesRoot(staging, "/Users/x")).toBe(join("/Users/x", "cashU Staging"));
    expect(hostAgentPlist(staging)).toBe("io.utopiasoft.cashu.staging.host.plist");
    expect(keychainService(staging, "vault", HASH)).toBe(`cashu.staging.vault.v1.${HASH}`);
    expect(staging.urlScheme).toBe("cashu-staging");
    expect(mcpServerName(staging, "jan")).toBe("cashu-staging-jan");
    expect(staging.updateFeed).toBe(false);
    expect(staging.inheritsPythonInstall).toBe(false);
  });

  it("shares no path, label, keychain namespace, scheme, bundle ID, MCP prefix, port or feed", () => {
    const fields = Object.keys(table.flavors.prod).sort();
    expect(Object.keys(RULES).sort()).toEqual(fields);
    expect(Object.keys(table.flavors.staging).sort()).toEqual(fields);
    for (const a of FLAVOR_IDS)
      for (const b of FLAVOR_IDS) {
        if (a === b) continue;
        for (const rule of Object.values(RULES)) rule(FLAVORS[a], FLAVORS[b]);
      }
    // Exactly one flavor has an update feed and replaces the Python install: prod.
    expect(FLAVOR_IDS.filter((id) => FLAVORS[id].updateFeed)).toEqual(["prod"]);
    expect(FLAVOR_IDS.filter((id) => FLAVORS[id].inheritsPythonInstall)).toEqual(["prod"]);
    // The retired Python app's launchd labels are never a host agent label.
    for (const id of FLAVOR_IDS)
      expect(["io.utopiasoft.cashu.worker", "io.github.synszakala.finanse.worker"]).not.toContain(
        FLAVORS[id].hostAgentLabel,
      );
  });

  it("maps a bundle ID to its flavor and refuses any other", () => {
    expect(flavorForBundleId("io.utopiasoft.cashu")).toBe(prod);
    expect(flavorForBundleId("io.utopiasoft.cashu.staging")).toBe(staging);
    expect(() => flavorForBundleId("com.github.Electron")).toThrow("unknown_bundle_flavor");
  });

  it("reads the flavor sealed in a bundle's Info.plist and finds the bundle of an executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "cashu-flavor-"));
    temps.push(dir);
    const plist = (id: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>\n`;
    const app = join(dir, "cashU Staging.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "Info.plist"), plist(staging.bundleId));
    writeFileSync(join(app, "Contents", "MacOS", "cashU"), "");
    writeFileSync(join(app, "Contents", "MacOS", "Electron"), "");
    if (process.platform === "darwin") {
      expect(bundleFlavor(app)).toBe(staging);
      writeFileSync(join(app, "Contents", "Info.plist"), plist("com.example.other"));
      expect(() => bundleFlavor(app)).toThrow("unknown_bundle_flavor");
    }
    const cashU = join(app, "Contents", "MacOS", "cashU");
    expect(packagedBundleOf(cashU, "darwin")?.endsWith(".app")).toBe(true);
    expect(packagedBundleOf(join(app, "Contents", "MacOS", "Electron"), "darwin")).toBeUndefined();
    expect(packagedBundleOf(process.execPath, "darwin")).toBeUndefined();
    // The Windows layout never matches a macOS bundle.
    expect(packagedBundleOf(cashU, "win32")).toBeUndefined();
    // A source run (node, vitest) is always prod.
    expect(processFlavor()).toBe(prod);
  });

  it("names the Windows data dir per flavor and refuses an unknown platform", () => {
    expect(dataDirName(prod, "win32")).toBe("cashU");
    expect(dataDirName(staging, "win32")).toBe("cashU Staging");
    expect(dataDirName(prod, "linux")).toBe("cashu");
    expect(() => dataDirName(prod, "freebsd")).toThrow("unsupported_platform");
  });
});

describe("Windows packaged identity", () => {
  const identity = (value: unknown) => `${JSON.stringify(value)}\n`;
  /** A synthetic install dir: `cashU.exe` and `resources/app-identity.json`. */
  function bare() {
    const dir = mkdtempSync(join(tmpdir(), "cashu-flavor-win-"));
    temps.push(dir);
    mkdirSync(join(dir, "resources"));
    writeFileSync(join(dir, WINDOWS_EXECUTABLE), "binary");
    writeFileSync(join(dir, "electron.exe"), "binary");
    return dir;
  }
  function install(record: unknown = { schema: 1, bundleId: prod.bundleId, version: "1.2.3" }) {
    const dir = bare();
    writeFileSync(
      join(dir, ...WINDOWS_APP_IDENTITY.split("/")),
      typeof record === "string" ? record : identity(record),
    );
    return dir;
  }

  it("reads only the exact identity record", () => {
    expect(readAppIdentity(install())).toEqual({
      schema: 1,
      bundleId: "io.utopiasoft.cashu",
      version: "1.2.3",
    });
    expect(
      readAppIdentity(install({ schema: 1, bundleId: staging.bundleId, version: "2.0.0-beta.1" }))
        .version,
    ).toBe("2.0.0-beta.1");
    const good = { schema: 1, bundleId: prod.bundleId, version: "1.2.3" };
    for (const bad of [
      { ...good, extra: true },
      { ...good, schema: 2 },
      { schema: 1, bundleId: prod.bundleId },
      { ...good, bundleId: "" },
      { ...good, bundleId: "cashu" },
      { ...good, bundleId: 7 },
      { ...good, version: "1.2" },
      { ...good, version: "v1.2.3" },
      [good],
      null,
      "not json",
      `${" ".repeat(4096)}${JSON.stringify(good)}`,
    ])
      expect(() => readAppIdentity(install(bad))).toThrow("app_identity_invalid");
    expect(() => readAppIdentity(bare())).toThrow("app_identity_invalid");
  });

  it("reads the flavor from app-identity.json and refuses an unknown bundle ID", () => {
    expect(bundleFlavor(install(), "win32")).toBe(prod);
    expect(
      bundleFlavor(install({ schema: 1, bundleId: staging.bundleId, version: "1.0.0" }), "win32"),
    ).toBe(staging);
    expect(() =>
      bundleFlavor(
        install({ schema: 1, bundleId: "com.example.other", version: "1.0.0" }),
        "win32",
      ),
    ).toThrow("unknown_bundle_flavor");
    expect(() => bundleFlavor(bare(), "win32")).toThrow("app_identity_invalid");
  });

  it("finds the install dir of cashU.exe beside its identity record only", () => {
    const dir = install();
    expect(packagedBundleOf(join(dir, WINDOWS_EXECUTABLE), "win32")).toBe(realpathSync.native(dir));
    expect(packagedBundleOf(join(dir, "electron.exe"), "win32")).toBeUndefined();
    expect(packagedBundleOf(join(dir, "missing.exe"), "win32")).toBeUndefined();
    expect(packagedBundleOf(join(bare(), WINDOWS_EXECUTABLE), "win32")).toBeUndefined();
    // The identity record must be a regular file, not a directory.
    const folder = bare();
    mkdirSync(join(folder, ...WINDOWS_APP_IDENTITY.split("/")));
    expect(packagedBundleOf(join(folder, WINDOWS_EXECUTABLE), "win32")).toBeUndefined();
    // The macOS layout never matches a Windows install.
    expect(packagedBundleOf(join(dir, WINDOWS_EXECUTABLE), "darwin")).toBeUndefined();
  });

  // File symlinks; on a Windows runner without the privilege to create them the test skips itself.
  it("refuses a linked identity record and follows a linked executable to its install dir", ({
    skip,
  }) => {
    const dir = install();
    const linked = bare();
    linkFile(
      join(dir, ...WINDOWS_APP_IDENTITY.split("/")),
      join(linked, ...WINDOWS_APP_IDENTITY.split("/")),
      skip,
    );
    expect(packagedBundleOf(join(linked, WINDOWS_EXECUTABLE), "win32")).toBeUndefined();
    expect(() => readAppIdentity(linked)).toThrow("app_identity_invalid");
    const elsewhere = mkdtempSync(join(tmpdir(), "cashu-flavor-link-"));
    temps.push(elsewhere);
    linkFile(join(dir, WINDOWS_EXECUTABLE), join(elsewhere, WINDOWS_EXECUTABLE), skip);
    expect(packagedBundleOf(join(elsewhere, WINDOWS_EXECUTABLE), "win32")).toBe(
      realpathSync.native(dir),
    );
  });

  it("derives a process flavor per platform: Windows install, else prod", () => {
    const stagingInstall = install({ schema: 1, bundleId: staging.bundleId, version: "1.0.0" });
    expect(executableFlavor(join(stagingInstall, WINDOWS_EXECUTABLE), "win32")).toBe(staging);
    expect(executableFlavor(join(install(), WINDOWS_EXECUTABLE), "win32")).toBe(prod);
    expect(executableFlavor(join(stagingInstall, "electron.exe"), "win32")).toBe(prod);
    expect(executableFlavor(process.execPath, "win32")).toBe(prod);
    // Linux has no packaged flavor detection, whatever the executable.
    expect(executableFlavor(join(stagingInstall, WINDOWS_EXECUTABLE), "linux")).toBe(prod);
    const unknown = install({ schema: 1, bundleId: "com.example.other", version: "1.0.0" });
    expect(() => executableFlavor(join(unknown, WINDOWS_EXECUTABLE), "win32")).toThrow(
      "unknown_bundle_flavor",
    );
  });
});
