import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readBundleIdentity } from "@cashu/node-host/bundle-identity";
import { writeWindowsInstall } from "@cashu/node-host/testing/windows-install";
import { afterEach, describe, expect, it } from "vitest";
import { runningBundleLayout } from "./localHost/startup.js";
import {
  hostFeatureGates,
  hostHome,
  main,
  type PackagedHostInput,
  packagedHostIdentity,
  requiresPackagedIdentity,
} from "./main.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("refuses a caller bundle flag from the source host", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cashu-host-identity-"));
  roots.push(dataDir);
  const errors: string[] = [];
  const io = {
    env: { CASHU_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: "1" },
    build: "desktop-1.0.0",
    stdout: () => undefined,
    stderr: (line: string) => {
      errors.push(line);
    },
    onSignal: () => undefined,
  };
  expect(
    await main(["run", "--data-dir", dataDir, "--bundle", join(dataDir, "fake.mjs")], io),
  ).toBe(64);
  expect(errors).toHaveLength(1);
});

it("keeps Electron-as-Node TypeScript source in the development path", () => {
  expect(requiresPackagedIdentity("/checkout")).toBe(false);
  expect(requiresPackagedIdentity(undefined)).toBe(true);
});

describe("Windows packaged host", () => {
  /** A verified synthetic install and the inputs of a host process running from it. */
  function running(resources: Record<string, string> = {}): {
    install: string;
    input: PackagedHostInput;
  } {
    const root = mkdtempSync(join(tmpdir(), "cashu-host-win-"));
    roots.push(root);
    const install = realpathSync.native(writeWindowsInstall(join(root, "cashU"), { resources }));
    const entry = join(install, "resources", "host.mjs");
    return {
      install,
      input: {
        ownEntry: entry,
        argvEntry: entry,
        execPath: join(install, "cashU.exe"),
        bundleArg: entry,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        platform: "win32",
      },
    };
  }

  it("takes its build from the install's verified identity record", () => {
    const { install, input } = running();
    const identity = readBundleIdentity(install, "win32");
    if (identity.kind !== "present") throw new Error("synthetic install did not verify");
    expect(packagedHostIdentity(input)).toEqual({
      bundle: install,
      build: `desktop-1.2.3-${identity.contentDigest}`,
      fingerprint: identity.fingerprint,
    });
    // The --bundle stamp is optional; NTFS case differences in the stamp are the same file.
    const { bundleArg: _, ...unstamped } = input;
    expect(packagedHostIdentity({ ...unstamped, bundleArg: undefined }).bundle).toBe(install);
    expect(packagedHostIdentity({ ...input, argvEntry: input.ownEntry.toUpperCase() }).bundle).toBe(
      install,
    );
  });

  it("refuses another entry, executable, stamp, Node mode or a tampered install", () => {
    const { install, input } = running();
    const other = join(install, "resources", "shim.mjs");
    writeFileSync(join(install, "electron.exe"), "binary");
    for (const bad of [
      { ...input, argvEntry: other },
      { ...input, bundleArg: other },
      { ...input, ownEntry: other, argvEntry: other, bundleArg: other },
      { ...input, execPath: join(install, "electron.exe") },
      { ...input, env: {} },
      { ...input, platform: "darwin" as const },
    ])
      expect(() => packagedHostIdentity(bad)).toThrow();
    writeFileSync(join(install, "resources", "app.asar"), "tampered");
    expect(() => packagedHostIdentity(input)).toThrow("invalid bundle identity");
  });

  it("refuses an install that carries a test-build marker, even a listed one", () => {
    const { install, input } = running({ "resources/test-build.json": "{}" });
    expect(readBundleIdentity(install, "win32").kind).toBe("present");
    expect(() => packagedHostIdentity(input)).toThrow("test_build_marker_unsupported");
  });

  it("starts only as the install's executable with its entry in the install's resources", () => {
    const { install } = running();
    const base = {
      bundlePath: install,
      execPath: join(install, "cashU.exe"),
      runtimeDir: join(install, "resources"),
      electronRunAsNode: "1",
      platform: "win32" as const,
    };
    expect(runningBundleLayout(base)).toEqual({
      resources: join(install, "resources"),
      executable: join(install, "cashU.exe"),
    });
    writeFileSync(join(install, "electron.exe"), "binary");
    expect(runningBundleLayout({ ...base, execPath: join(install, "electron.exe") })).toBe(
      undefined,
    );
    expect(runningBundleLayout({ ...base, runtimeDir: install })).toBeUndefined();
    expect(runningBundleLayout({ ...base, electronRunAsNode: undefined })).toBeUndefined();
    expect(runningBundleLayout({ ...base, execPath: join(install, "missing.exe") })).toBe(
      undefined,
    );
  });

  it("runs the classifier and Open Banking on Windows, but not connectors or OS notifications", () => {
    expect(hostFeatureGates("win32")).toEqual({
      classifier: true,
      banking: true,
      connectors: false,
      notifications: false,
    });
    expect(hostFeatureGates("darwin")).toEqual({
      classifier: true,
      banking: true,
      connectors: true,
      notifications: true,
    });
    expect(hostFeatureGates("linux")).toEqual({
      classifier: true,
      banking: true,
      connectors: false,
      notifications: false,
    });
    expect(hostFeatureGates("freebsd")).toEqual({
      classifier: false,
      banking: false,
      connectors: false,
      notifications: false,
    });
  });
});

describe("host home", () => {
  it("uses HOME on macOS and Linux and USERPROFILE on Windows, never a Git Bash HOME", () => {
    const env = { HOME: "/c/Users/anna", USERPROFILE: "C:\\Users\\anna" };
    expect(hostHome(env, "darwin")).toBe("/c/Users/anna");
    expect(hostHome(env, "linux")).toBe("/c/Users/anna");
    expect(hostHome(env, "win32")).toBe("C:\\Users\\anna");
    expect(hostHome({ HOME: "/c/Users/anna" }, "win32")).toBe(homedir());
    expect(hostHome({ HOME: "", USERPROFILE: "C:\\Users\\anna" }, "darwin")).toBe(homedir());
    expect(hostHome({ USERPROFILE: "" }, "win32")).toBe(homedir());
  });
});
