import { describe, expect, it } from "vitest";
import { notaryCredentialArgs, notaryLabel, parsePackageArgs } from "./package-args.mjs";

const identity = "Developer ID Application: Example Sp. z o.o. (ABCDE12345)";
const marker = {
  schema: 1,
  kind: "cashu-test-build",
  feedUrl: "http://127.0.0.1:47123/",
  installRoot: "/tmp/w3a/install",
  dataDir: "/tmp/w3a/data",
  workspacesDir: "/tmp/w3a/workspaces",
};
const issuer = "12345678-90ab-cdef-1234-567890abcdef";
const parse = (argv, io = {}) => parsePackageArgs(argv, { cwd: "/work", ...io });

describe("package-macos arguments", () => {
  it("keeps the ad hoc and keychain-profile release command lines", () => {
    expect(parse(["arm64"])).toMatchObject({
      arch: "arm64",
      identity: null,
      notary: null,
      testBuild: null,
      appVersion: null,
      out: null,
    });
    expect(
      parse(["x64", "--dmg", "--out", "dist", "--sign", identity, "--notarize", "cashu-notary"]),
    ).toMatchObject({
      arch: "x64",
      withDmg: true,
      out: "/work/dist",
      identity,
      keychain: null,
      notary: { kind: "profile", profile: "cashu-notary" },
    });
  });

  it("builds the staging flavor ad hoc only", () => {
    expect(parse(["arm64"]).flavor).toBe("prod");
    expect(parse(["arm64", "--flavor", "staging", "--dmg"])).toMatchObject({
      arch: "arm64",
      flavor: "staging",
      withDmg: true,
      identity: null,
      notary: null,
      testBuild: null,
    });
    expect(() => parse(["arm64", "--flavor", "beta"])).toThrow(/--flavor is one of prod, staging/);
    for (const extra of [
      ["--sign", identity],
      ["--sign", identity, "--notarize", "cashu-notary"],
      ["--test-build", JSON.stringify(marker)],
    ])
      expect(() => parse(["arm64", "--flavor", "staging", ...extra])).toThrow(
        /is not for --flavor staging \(ad hoc only\)/,
      );
    expect(parse(["arm64", "--flavor", "prod", "--sign", identity]).identity).toBe(identity);
  });

  it("accepts an App Store Connect API key and a signing keychain for CI", () => {
    const options = parse([
      "arm64",
      "--sign",
      identity,
      "--keychain",
      "ci.keychain-db",
      "--notary-key",
      "keys/AuthKey_ABCD123456.p8",
      "--notary-key-id",
      "ABCD123456",
      "--notary-issuer",
      issuer,
    ]);
    expect(options.keychain).toBe("/work/ci.keychain-db");
    expect(options.notary).toEqual({
      kind: "api-key",
      keyPath: "/work/keys/AuthKey_ABCD123456.p8",
      keyId: "ABCD123456",
      issuer,
    });
    expect(notaryCredentialArgs(options.notary)).toEqual([
      "--key",
      "/work/keys/AuthKey_ABCD123456.p8",
      "--key-id",
      "ABCD123456",
      "--issuer",
      issuer,
    ]);
    // The printable label names the key ID and issuer, never the key file.
    expect(notaryLabel(options.notary)).toBe(`App Store Connect key ABCD123456 (issuer ${issuer})`);
    expect(notaryLabel(options.notary)).not.toContain("AuthKey");
    expect(notaryCredentialArgs({ kind: "profile", profile: "p" })).toEqual([
      "--keychain-profile",
      "p",
    ]);
  });

  it("refuses inconsistent notarization and signing flags", () => {
    const key = [
      "--notary-key",
      "k.p8",
      "--notary-key-id",
      "ABCD123456",
      "--notary-issuer",
      issuer,
    ];
    for (const argv of [
      ["universal"],
      ["arm64", "--bogus"],
      ["arm64", "--out"],
      ["arm64", "--out", "--dmg"],
      ["arm64", "--dmg", "--dmg"],
      ["arm64", "--notarize", "p"],
      ["arm64", "--keychain", "k.keychain-db"],
      ["arm64", "--sign", identity, "--notarize", "bad profile"],
      ["arm64", ...key],
      ["arm64", "--sign", identity, "--notarize", "p", ...key],
      ["arm64", "--sign", identity, "--notary-key", "k.p8", "--notary-key-id", "ABCD123456"],
      ["arm64", "--sign", identity, "--notary-key", "k.pem", ...key.slice(2)],
      ["arm64", "--sign", identity, ...key.slice(0, 2), "--notary-key-id", "x", ...key.slice(4)],
      ["arm64", "--sign", identity, ...key.slice(0, 4), "--notary-issuer", "not-a-uuid"],
    ])
      expect(() => parse(argv), argv.join(" ")).toThrow(/usage:/);
  });

  it("parses a test build marker from JSON or a file, and its version override", () => {
    const json = JSON.stringify(marker);
    expect(parse(["arm64", "--sign", identity, "--test-build", json])).toMatchObject({
      testBuild: marker,
      appVersion: null,
    });
    const read = [];
    const options = parse(["arm64", "--test-build", "@marker.json", "--app-version", "0.5.1"], {
      readText: (path) => {
        read.push(path);
        return json;
      },
    });
    expect(read).toEqual(["/work/marker.json"]);
    expect(options).toMatchObject({ testBuild: marker, appVersion: "0.5.1" });
    for (const argv of [
      ["arm64", "--app-version", "0.5.1"],
      ["arm64", "--test-build", json, "--app-version", "0.5"],
      ["arm64", "--test-build", JSON.stringify({ ...marker, feedUrl: "https://x.example/" })],
      ["arm64", "--test-build", JSON.stringify({ ...marker, installRoot: "/Applications" })],
      ["arm64", "--test-build", "{not json"],
    ])
      expect(() => parse(argv), argv.join(" ")).toThrow(/usage:/);
  });
});
