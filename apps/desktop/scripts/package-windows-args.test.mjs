import { describe, expect, it } from "vitest";
import {
  AZURE_CREDENTIALS,
  AZURE_SETTINGS,
  assertWindowsHost,
  azureSigningFromEnv,
  buildEnv,
  builderEnv,
  parseWindowsPackageArgs,
  signingLabel,
} from "./package-windows-args.mjs";

const parse = (argv) => parseWindowsPackageArgs(argv, { cwd: "/work" });
const azureEnv = {
  CASHU_AZURE_ENDPOINT: "https://weu.codesigning.azure.net/",
  CASHU_AZURE_ACCOUNT: "cashu-signing",
  CASHU_AZURE_CERT_PROFILE: "cashu-public",
  CASHU_AZURE_PUBLISHER: "Example Sp. z o.o.",
  AZURE_TENANT_ID: "tenant-value",
  AZURE_CLIENT_ID: "client-value",
  AZURE_CLIENT_SECRET: "secret-value",
};

describe("package-windows arguments", () => {
  it("parses the unsigned and the Azure command lines", () => {
    expect(parse(["x64"])).toEqual({
      arch: "x64",
      flavor: "prod",
      out: null,
      reuseDesktop: false,
      sign: null,
    });
    expect(
      parse(["x64", "--out", "dist", "--reuse-desktop", "--sign", "azure", "--flavor", "prod"]),
    ).toEqual({
      arch: "x64",
      flavor: "prod",
      out: "/work/dist",
      reuseDesktop: true,
      sign: "azure",
    });
  });

  it("refuses other architectures, flavors, signers and malformed flags", () => {
    for (const argv of [
      [],
      ["arm64"],
      ["--out", "dist"],
      ["x64", "--flavor", "staging"],
      ["x64", "--flavor", "beta"],
      ["x64", "--sign", "signtool"],
      ["x64", "--sign"],
      ["x64", "--out", "--reuse-desktop"],
      ["x64", "--reuse-desktop", "--reuse-desktop"],
      ["x64", "--dmg"],
      ["x64", "--test-build", "{}"],
    ])
      expect(() => parse(argv), argv.join(" ")).toThrow(/usage:/);
    expect(() => parse(["x64", "--flavor", "staging"])).toThrow(/prod only/);
  });

  it("runs on Windows only", () => {
    expect(() => assertWindowsHost("win32")).not.toThrow();
    for (const platform of ["darwin", "linux"])
      expect(() => assertWindowsHost(platform)).toThrow(/runs on Windows only \(this is /);
  });
});

describe("Azure Trusted Signing environment", () => {
  it("reads the public settings and never returns a credential", () => {
    const azure = azureSigningFromEnv(azureEnv);
    expect(azure).toEqual({
      endpoint: "https://weu.codesigning.azure.net/",
      account: "cashu-signing",
      certificateProfile: "cashu-public",
      publisher: "Example Sp. z o.o.",
    });
    const label = signingLabel(azure);
    for (const name of AZURE_CREDENTIALS) expect(label).not.toContain(azureEnv[name]);
    expect(signingLabel(null)).toBe("none (unsigned build)");
  });

  it("lists every missing name at once and no value", () => {
    expect(() => azureSigningFromEnv({})).toThrow(
      `--sign azure: missing environment ${[...AZURE_SETTINGS.map(([name]) => name), ...AZURE_CREDENTIALS].join(", ")}`,
    );
    const partial = { ...azureEnv, CASHU_AZURE_PUBLISHER: "  ", AZURE_CLIENT_SECRET: undefined };
    let message = "";
    try {
      azureSigningFromEnv(partial);
    } catch (error) {
      message = error.message;
    }
    expect(message).toBe(
      "--sign azure: missing environment CASHU_AZURE_PUBLISHER, AZURE_CLIENT_SECRET",
    );
    for (const value of Object.values(azureEnv)) expect(message).not.toContain(value);
  });

  it("refuses malformed settings", () => {
    for (const [name, value] of [
      ["CASHU_AZURE_ENDPOINT", "http://weu.codesigning.azure.net/"],
      ["CASHU_AZURE_ENDPOINT", "not a url"],
      ["CASHU_AZURE_ENDPOINT", "https://user:pw@weu.codesigning.azure.net/"],
      ["CASHU_AZURE_ACCOUNT", "bad account"],
      ["CASHU_AZURE_CERT_PROFILE", "-profile"],
      ["CASHU_AZURE_PUBLISHER", 'Quote "Inc"'],
      ["CASHU_AZURE_PUBLISHER", "Line\nbreak"],
    ])
      expect(() => azureSigningFromEnv({ ...azureEnv, [name]: value }), `${name}=${value}`).toThrow(
        name,
      );
  });
});

describe("electron-builder environment", () => {
  const env = {
    Path: "C:\\Windows",
    CSC_LINK: "cert.pfx",
    csc_key_password: "pw",
    WIN_CSC_LINK: "cert.pfx",
    Win_Csc_Key_Password: "pw",
    APPLE_ID: "a",
    GH_TOKEN: "t",
    github_token: "t",
    ELECTRON_BUILDER_PUBLISH: "always",
    AZURE_TENANT_ID: "tenant",
    azure_client_secret: "secret",
    CASHU_AZURE_ACCOUNT: "cashu-signing",
    UNSET: undefined,
  };

  it("strips every signing and publishing input of an unsigned build, in any case", () => {
    expect(builderEnv(env, null)).toEqual({
      Path: "C:\\Windows",
      CASHU_AZURE_ACCOUNT: "cashu-signing",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES: "false",
    });
  });

  it("keeps the Azure credentials for an Azure build, never a signtool certificate", () => {
    expect(builderEnv(env, "azure")).toEqual({
      Path: "C:\\Windows",
      AZURE_TENANT_ID: "tenant",
      azure_client_secret: "secret",
      CASHU_AZURE_ACCOUNT: "cashu-signing",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES: "false",
    });
  });

  it("gives every other child no Azure name at all, settings included, in any case", () => {
    const built = buildEnv({ ...env, cashu_azure_publisher: "Example", CASHU_AZURE_ENDPOINT: "x" });
    expect(built).toEqual({
      Path: "C:\\Windows",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES: "false",
    });
    expect(Object.keys(built).filter((key) => /AZURE/i.test(key))).toEqual([]);
  });
});
