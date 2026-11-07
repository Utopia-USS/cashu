// Command line of package-macos.mjs, parsed and validated without side effects (tested in
// package-args.test.mjs). Nothing here reads a key, prints a secret or touches the keychain.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTestBuild } from "./release-policy.mjs";

export const USAGE =
  "usage: node package-macos.mjs <arm64|x64> [--dmg] [--reuse-desktop] [--out <dir>]\n" +
  '  [--sign "Developer ID Application: <name> (<TEAMID>)" [--keychain <path>]\n' +
  "    [--notarize <keychain-profile> | --notary-key <AuthKey.p8> --notary-key-id <id> --notary-issuer <uuid>]]\n" +
  "  [--test-build <json | @file> [--app-version <X.Y.Z>]]";

const VALUE_FLAGS = [
  "--out",
  "--sign",
  "--keychain",
  "--notarize",
  "--notary-key",
  "--notary-key-id",
  "--notary-issuer",
  "--test-build",
  "--app-version",
];
const BOOLEAN_FLAGS = ["--dmg", "--reuse-desktop"];

function usage(reason) {
  return new Error(`${reason}\n${USAGE}`);
}

/**
 * @param {readonly string[]} argv arguments after the script path
 * @param {{ cwd?: string, readText?: (path: string) => string }} [io]
 * @returns {{ arch: "arm64" | "x64", withDmg: boolean, reuseDesktop: boolean, out: string | null,
 *   identity: string | null, keychain: string | null,
 *   notary: null | { kind: "profile", profile: string }
 *     | { kind: "api-key", keyPath: string, keyId: string, issuer: string },
 *   testBuild: null | { schema: 1, kind: "cashu-test-build", feedUrl: string, installRoot: string, dataDir: string },
 *   appVersion: string | null }}
 */
export function parsePackageArgs(argv, io = {}) {
  const cwd = io.cwd ?? process.cwd();
  const readText = io.readText ?? ((path) => readFileSync(path, "utf8"));
  const [first, ...rest] = argv;
  const arch = first ?? process.arch;
  if (!["arm64", "x64"].includes(arch)) throw usage("the first argument is arm64 or x64");
  const seen = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (seen.has(flag)) throw usage(`${flag} is given twice`);
    if (BOOLEAN_FLAGS.includes(flag)) seen.set(flag, true);
    else if (VALUE_FLAGS.includes(flag)) {
      const value = rest[index + 1];
      if (value === undefined || value === "" || value.startsWith("--"))
        throw usage(`${flag} needs a value`);
      seen.set(flag, value);
      index += 1;
    } else throw usage(`unknown argument ${flag}`);
  }
  const value = (flag) => seen.get(flag) ?? null;
  const identity = value("--sign");
  const keychain = value("--keychain");
  if (keychain && !identity) throw usage("--keychain needs --sign");
  const profile = value("--notarize");
  const keyPath = value("--notary-key");
  const keyId = value("--notary-key-id");
  const issuer = value("--notary-issuer");
  const apiKeyFlags = [keyPath, keyId, issuer].filter((item) => item !== null).length;
  let notary = null;
  if (profile && apiKeyFlags > 0)
    throw usage("--notarize and --notary-key/--notary-key-id/--notary-issuer exclude each other");
  if (profile) {
    if (!identity) throw usage("--notarize needs --sign");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(profile)) throw usage("Unexpected keychain profile name");
    notary = { kind: "profile", profile };
  } else if (apiKeyFlags > 0) {
    if (apiKeyFlags !== 3)
      throw usage("--notary-key, --notary-key-id and --notary-issuer go together");
    if (!identity) throw usage("--notary-key needs --sign");
    if (!/\.p8$/.test(keyPath))
      throw usage("--notary-key expects an App Store Connect .p8 key file");
    if (!/^[A-Z0-9]{8,12}$/.test(keyId))
      throw usage("--notary-key-id is not an App Store Connect key ID");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issuer))
      throw usage("--notary-issuer is not an issuer UUID");
    notary = { kind: "api-key", keyPath: resolve(cwd, keyPath), keyId, issuer };
  }
  const testSource = value("--test-build");
  let testBuild = null;
  if (testSource) {
    const text = testSource.startsWith("@")
      ? readText(resolve(cwd, testSource.slice(1)))
      : testSource;
    try {
      testBuild = parseTestBuild(text);
    } catch (error) {
      throw usage(`--test-build: ${error instanceof Error ? error.message : "invalid marker"}`);
    }
  }
  const appVersion = value("--app-version");
  if (appVersion && !testBuild) throw usage("--app-version is for --test-build builds only");
  if (appVersion && !/^\d+\.\d+\.\d+$/.test(appVersion)) throw usage("--app-version must be X.Y.Z");
  const out = value("--out");
  return {
    arch,
    withDmg: seen.has("--dmg"),
    reuseDesktop: seen.has("--reuse-desktop"),
    out: out === null ? null : resolve(cwd, out),
    identity,
    keychain: keychain === null ? null : resolve(cwd, keychain),
    notary,
    testBuild,
    appVersion,
  };
}

/** notarytool credential arguments; the key file is passed by path and never read here. */
export function notaryCredentialArgs(notary) {
  if (notary.kind === "profile") return ["--keychain-profile", notary.profile];
  return ["--key", notary.keyPath, "--key-id", notary.keyId, "--issuer", notary.issuer];
}

/** What may be printed about the notary credential: never the key path or its contents. */
export function notaryLabel(notary) {
  return notary.kind === "profile"
    ? `keychain profile ${notary.profile}`
    : `App Store Connect key ${notary.keyId} (issuer ${notary.issuer})`;
}
