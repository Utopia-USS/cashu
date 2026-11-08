import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appBundleName,
  bundleFlavor,
  dataDirName,
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
  workspacesRoot,
} from "./flavor.js";
import table from "./flavor.json" with { type: "json" };

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
    for (const platform of ["darwin", "linux"] as const)
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
  lanPairingPort: different((f) => f.lanPairingPort),
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
      dataDirName: { darwin: "cashU", linux: "cashu" },
      workspacesDirName: "cashU",
      hostAgentLabel: "io.utopiasoft.cashu.host",
      keychainPrefix: "cashu",
      urlScheme: "cashu",
      mcpServerPrefix: "cashu",
      lanPairingPort: 8517,
      updateFeed: true,
      inheritsPythonInstall: true,
      iconBadge: null,
      buildDir: "build/t46",
      artifactPrefix: "cashU",
    });
    expect(keychainService(prod, "vault", HASH)).toBe(`cashu.vault.v1.${HASH}`);
    expect(hostAgentPlist(prod)).toBe("io.utopiasoft.cashu.host.plist");
    expect(mcpServerName(prod, "jan")).toBe("cashu-jan");
    expect(workspacesRoot(prod, "/Users/x")).toBe("/Users/x/cashU");
    expect(legacyWorkspacesRoot(prod, "/Users/x")).toBe("/Users/x/Documents/cashU");
    expect(appBundleName(prod)).toBe("cashU.app");
  });

  it("names the staging app as the owner decided", () => {
    expect(staging.bundleId).toBe("io.utopiasoft.cashu.staging");
    expect(appBundleName(staging)).toBe("cashU Staging.app");
    expect(dataDirName(staging, "darwin")).toBe("cashU Staging");
    expect(workspacesRoot(staging, "/Users/x")).toBe("/Users/x/cashU Staging");
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
    expect(packagedBundleOf(join(app, "Contents", "MacOS", "cashU"))?.endsWith(".app")).toBe(true);
    expect(packagedBundleOf(join(app, "Contents", "MacOS", "Electron"))).toBeUndefined();
    expect(packagedBundleOf(process.execPath)).toBeUndefined();
    // A source run (node, vitest) is always prod.
    expect(processFlavor()).toBe(prod);
  });
});
