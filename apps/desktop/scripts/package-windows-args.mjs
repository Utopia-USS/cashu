// Command line and environment of package-windows.mjs, parsed and validated without side effects
// (tested in package-windows-args.test.mjs, on any OS). Nothing here prints a secret: the Azure
// client secret and the tenant / client IDs are only checked for presence by name, never read into
// the builder config (the TrustedSigning PowerShell module reads them from the environment).
import { resolve } from "node:path";

export const WINDOWS_USAGE =
  "usage: node package-windows.mjs x64 [--out <dir>] [--reuse-desktop] [--sign azure] [--flavor prod]";

const VALUE_FLAGS = ["--out", "--sign", "--flavor"];
const BOOLEAN_FLAGS = ["--reuse-desktop"];

/** The non-secret Azure Trusted Signing settings, by environment name. */
export const AZURE_SETTINGS = Object.freeze([
  ["CASHU_AZURE_ENDPOINT", "endpoint"],
  ["CASHU_AZURE_ACCOUNT", "account"],
  ["CASHU_AZURE_CERT_PROFILE", "certificateProfile"],
  ["CASHU_AZURE_PUBLISHER", "publisher"],
]);
/** The service principal the TrustedSigning module authenticates with (EnvironmentCredential). */
export const AZURE_CREDENTIALS = Object.freeze([
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
]);

function usage(reason) {
  return new Error(`${reason}\n${WINDOWS_USAGE}`);
}

/** Windows packages are built on Windows only (keyring binding, NSIS, Authenticode checks). */
export function assertWindowsHost(platform) {
  if (platform !== "win32")
    throw new Error(
      `package-windows.mjs runs on Windows only (this is ${platform}): pnpm installs only this OS's native bindings, and the installer and its signatures are built and checked with Windows tools. Use the windows-latest CI job.`,
    );
}

/**
 * @param {readonly string[]} argv arguments after the script path
 * @param {{ cwd?: string }} [io]
 * @returns {{ arch: "x64", flavor: "prod", out: string | null, reuseDesktop: boolean, sign: "azure" | null }}
 */
export function parseWindowsPackageArgs(argv, io = {}) {
  const cwd = io.cwd ?? process.cwd();
  const [first, ...rest] = argv;
  if (first !== "x64") throw usage("the first argument is x64 (the only Windows architecture)");
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
  // Only the released prod flavor exists on Windows; staging is the owner's local Mac app.
  const flavor = seen.get("--flavor") ?? "prod";
  if (flavor !== "prod") throw usage(`--flavor ${flavor} is not packaged for Windows (prod only)`);
  const sign = seen.get("--sign") ?? null;
  if (sign !== null && sign !== "azure") throw usage("--sign takes azure (Azure Trusted Signing)");
  const out = seen.get("--out") ?? null;
  return {
    arch: "x64",
    flavor: "prod",
    out: out === null ? null : resolve(cwd, out),
    reuseDesktop: seen.has("--reuse-desktop"),
    sign,
  };
}

/** Whether an environment value is set (present and not blank). */
function present(env, name) {
  return typeof env[name] === "string" && env[name].trim() !== "";
}

/**
 * The Azure Trusted Signing settings for `--sign azure`. Every missing name (settings and
 * credentials) is listed in one error; no value is ever part of an error.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{ endpoint: string, account: string, certificateProfile: string, publisher: string }}
 */
export function azureSigningFromEnv(env) {
  const missing = [...AZURE_SETTINGS.map(([name]) => name), ...AZURE_CREDENTIALS].filter(
    (name) => !present(env, name),
  );
  if (missing.length > 0)
    throw new Error(`--sign azure: missing environment ${missing.join(", ")}`);
  const settings = Object.fromEntries(AZURE_SETTINGS.map(([name, key]) => [key, env[name].trim()]));
  let endpoint;
  try {
    endpoint = new URL(settings.endpoint);
  } catch {
    throw new Error("CASHU_AZURE_ENDPOINT is not a URL");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search)
    throw new Error("CASHU_AZURE_ENDPOINT must be a plain https URL");
  // Trusted Signing account and certificate profile names: letters, digits and hyphens.
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,62}[A-Za-z0-9]$/.test(settings.account))
    throw new Error("CASHU_AZURE_ACCOUNT is not a Trusted Signing account name");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,98}[A-Za-z0-9]$/.test(settings.certificateProfile))
    throw new Error("CASHU_AZURE_CERT_PROFILE is not a certificate profile name");
  // The publisher is the certificate subject's common name; it is compared verbatim.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
  if (settings.publisher.length > 256 || /[\u0000-\u001f\u007f"]/.test(settings.publisher))
    throw new Error("CASHU_AZURE_PUBLISHER is not a certificate subject name");
  return settings;
}

/**
 * The environment electron-builder runs with. Never: publish tokens, macOS signing or notarization
 * settings, signtool certificates (CSC_* / WIN_CSC_*; electron-builder would auto-discover them).
 * Unsigned builds also drop every AZURE_* name, so nothing can sign by discovery; an Azure build keeps
 * them for the TrustedSigning module. Windows environment names are case-insensitive, so matching is.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {"azure" | null} sign
 */
export function builderEnv(env, sign) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(CSC_|WIN_CSC_|APPLE_|NOTARIZE_|ELECTRON_BUILDER_PUBLISH)/i.test(key)) continue;
    if (/^(GH_TOKEN|GITHUB_TOKEN)$/i.test(key)) continue;
    if (sign !== "azure" && /^AZURE_/i.test(key)) continue;
    result[key] = value;
  }
  result.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  result.ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES = "false";
  return result;
}

/**
 * The environment of every child but electron-builder (the desktop build and its bundler plugins,
 * build-host.mjs, git, the package verifier): `builderEnv` of an unsigned build without the
 * CASHU_AZURE_* settings either, so no Azure name reaches code that has no use for it. Only the two
 * electron-builder runs get `builderEnv(env, "azure")`.
 * @param {Readonly<Record<string, string | undefined>>} env
 */
export function buildEnv(env) {
  const result = builderEnv(env, null);
  for (const key of Object.keys(result)) if (/^CASHU_AZURE_/i.test(key)) delete result[key];
  return result;
}

/** What may be printed about the signing setup (no credential, only the public settings). */
export function signingLabel(azure) {
  return azure
    ? `Azure Trusted Signing: account ${azure.account}, profile ${azure.certificateProfile}, publisher "${azure.publisher}"`
    : "none (unsigned build)";
}
