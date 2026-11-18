// build/flavor-config.cjs: the macOS bundle keeps the exact resource layout it had before the
// Windows target existed, and the Windows target is per-user, keeps user data and signs only on request.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const { builderConfig, WINDOWS_NSIS_INCLUDE, WINDOWS_PACKAGE_NAME } = createRequire(
  import.meta.url,
)("../build/flavor-config.cjs");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const buildResources = join(root, "apps/desktop/build");
const azure = {
  endpoint: "https://weu.codesigning.azure.net/",
  account: "cashu-signing",
  certificateProfile: "cashu-public",
  publisher: "Example Sp. z o.o.",
};

/** What electron-builder copies for a --mac build: the top-level entries, then the mac ones. */
function macCopies(config) {
  const entries = (list) => (list ?? []).map(({ from, to }) => `${from} -> ${to}`);
  return {
    extraResources: [...entries(config.extraResources), ...entries(config.mac.extraResources)],
    extraFiles: [...entries(config.extraFiles), ...entries(config.mac.extraFiles)],
  };
}

describe("flavor-config.cjs", () => {
  it("copies exactly the macOS resources and files of the pre-Windows config", () => {
    for (const [id, label] of [
      ["prod", "io.utopiasoft.cashu.host"],
      ["staging", "io.utopiasoft.cashu.staging.host"],
    ]) {
      const work = join(root, id === "prod" ? "build/t46" : "build/staging");
      const resources = join(work, "resources");
      const copies = macCopies(builderConfig(id));
      expect(copies.extraResources.sort()).toEqual(
        [
          ...["host.mjs", "shim.mjs", "notify-catalog-v1.json"].map(
            (file) => `${join(resources, file)} -> ${file}`,
          ),
          ...["native", "node_modules", "skills", "connectors", "renderer"].map(
            (dir) => `${join(resources, dir)} -> ${dir}`,
          ),
        ].sort(),
      );
      expect(copies.extraFiles).toEqual([
        `${join(resources, "cashu-host-agent")} -> MacOS/cashu-host-agent`,
        `${join(resources, "launch-agents", `${label}.plist`)} -> Library/LaunchAgents/${label}.plist`,
      ]);
    }
  });

  it("keeps the macOS package metadata unchanged", () => {
    const prod = builderConfig("prod");
    expect(prod.extraMetadata).toBeUndefined();
    expect(prod.extraFiles).toBeUndefined();
    expect(prod.mac.identity).toBeNull();
    expect(prod.publish).toBeNull();
    expect(builderConfig("prod", { appVersion: "0.5.1" }).extraMetadata).toEqual({
      version: "0.5.1",
    });
    expect(builderConfig("staging", { icon: "/x/staging.icns" }).mac.icon).toBe("/x/staging.icns");
  });

  it("describes an unsigned per-user installer that never deletes user data", () => {
    const config = builderConfig("prod", { target: "win" });
    expect(config.extraMetadata).toEqual({ name: WINDOWS_PACKAGE_NAME });
    expect(config.win).toMatchObject({
      target: [{ target: "nsis", arch: ["x64"] }],
      icon: join(root, "packaging/icon/cashu-1024.png"),
      signAndEditExecutable: true,
      signExecutable: false,
    });
    expect(config.win.azureSignOptions).toBeUndefined();
    expect(config.nsis).toMatchObject({
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      packElevateHelper: false,
      deleteAppDataOnUninstall: false,
      differentialPackage: false,
      shortcutName: "cashU",
      uninstallDisplayName: "cashU",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the electron-builder macro itself.
      artifactName: "cashU-${version}-win-x64.exe",
    });
    expect(config.publish).toBeNull();
    // No Windows build carries the macOS-only pieces: they live under `mac` only.
    const everywhere = JSON.stringify({ ...config, mac: undefined });
    for (const piece of ["native", "cashu-host-agent", "LaunchAgents"])
      expect(everywhere).not.toContain(piece);
  });

  it("removes this install's cashu:// registration on uninstall and nothing else", () => {
    expect(builderConfig("prod", { target: "win" }).nsis.include).toBe(WINDOWS_NSIS_INCLUDE);
    expect(dirname(WINDOWS_NSIS_INCLUDE)).toBe(buildResources);
    const script = readFileSync(WINDOWS_NSIS_INCLUDE, "utf8");
    const code = script
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith(";"));
    const { urlScheme } = JSON.parse(
      readFileSync(join(root, "packages/node-host/src/flavor.json"), "utf8"),
    ).flavors.prod;
    const key = `Software\\Classes\\${urlScheme}`;
    // One macro, run by the uninstaller only, never on an update's uninstall.
    expect(code.filter((line) => line.startsWith("!macro "))).toEqual(["!macro customUnInstall"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: NSIS LogicLib syntax, not a template.
    expect(code).toContain("${ifNot} ${isUpdated}");
    // The key goes only when its command is Electron's default for this install's cashU.exe.
    expect(code).toContain(`ReadRegStr $R0 HKCU "${key}\\shell\\open\\command" ""`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: NSIS LogicLib syntax and a define.
    expect(code).toContain('${if} $R0 == `"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "%1"`');
    expect(code.filter((line) => /^DeleteReg/i.test(line))).toEqual([`DeleteRegKey HKCU "${key}"`]);
    // No file is written, copied, moved or deleted (install folder and data dir untouched), nothing
    // runs and no other registry value changes.
    const forbidden =
      /^(File|SetOutPath|CopyFiles|Rename|Delete|RMDir|CreateDirectory|WriteUninstaller|Exec|ExecWait|ExecShell|nsExec|WriteReg|DeleteRegValue|!system|!execute)\b/i;
    expect(code.filter((line) => forbidden.test(line))).toEqual([]);
  });

  it("holds no file in build/ that electron-builder would pick up by itself", () => {
    // electron-builder reads its build resources dir (apps/desktop/build) for well-known names
    // (installer.nsh, installerIcon.ico, uninstallerIcon.ico, license files, NSIS plugin dirs, ...),
    // some of which change what an install writes. Only these files live there; a new one is a
    // deliberate change of this list.
    expect(readdirSync(buildResources).sort()).toEqual([
      "electron-builder.config.cjs",
      "entitlements.mac.plist",
      "entitlements.release.mac.plist",
      "flavor-config.cjs",
      "windows-uninstall.nsh",
    ]);
  });

  it("signs with Azure only when asked, everything it ships, failing on any unsigned file", () => {
    const config = builderConfig("prod", { target: "win", azure });
    expect(config.win).toMatchObject({
      signExecutable: true,
      signExts: [".dll", ".node"],
      forceCodeSigning: true,
      azureSignOptions: {
        publisherName: azure.publisher,
        endpoint: azure.endpoint,
        codeSigningAccountName: azure.account,
        certificateProfileName: azure.certificateProfile,
      },
    });
    expect(() =>
      builderConfig("prod", { target: "win", azure: { ...azure, account: "" } }),
    ).toThrow(/needs account/);
    expect(() => builderConfig("prod", { azure })).toThrow(/for Windows builds/);
    expect(() => builderConfig("staging", { target: "win" })).toThrow(/Only the prod flavor/);
    expect(() => builderConfig("prod", { target: "linux" })).toThrow(/Unknown target/);
  });
});
