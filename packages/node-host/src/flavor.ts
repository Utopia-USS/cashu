// The build flavors of the desktop app: `prod` (the released cashU.app) and `staging` (the owner's
// local second app "cashU Staging", built ad hoc from a checkout, never released, no update feed).
// flavor.json is the single source of truth; the packaging scripts (electron-builder flavor config,
// package-macos.mjs, verify-package.mjs, release-policy.mjs, build-native.mjs) read the same file.
//
// The flavor is decided at build time and sealed in the bundle: electron-builder writes the flavor's
// bundle ID into Contents/Info.plist (covered by the code signature and the bundle content digest),
// and the native helpers are compiled with the flavor's constants. At run time every process of a
// packaged app (Electron main, the host, the `cashu` shim) derives its flavor from the Info.plist of
// the bundle its executable belongs to (`processFlavor`); an unknown bundle ID is refused. Source runs
// (dev, tests, e2e) are always `prod`. Code never branches on the flavor's name: it asks the table.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import table from "./flavor.json" with { type: "json" };

export const FLAVOR_IDS = ["prod", "staging"] as const;
export type FlavorId = (typeof FLAVOR_IDS)[number];

export interface Flavor {
  readonly id: FlavorId;
  /** CFBundleIdentifier, and the identity the native helpers accept. */
  readonly bundleId: string;
  /** CFBundleName, the `.app` name, the window title and the Electron app name. */
  readonly productName: string;
  /** The default data dir's last component per platform (`~/Library/Application Support/<name>`). */
  readonly dataDirName: { readonly darwin: string; readonly linux: string };
  /** The default agent workspaces root: `~/<name>` (like IntelliJ's `~/IdeaProjects`). */
  readonly workspacesDirName: string;
  /** launchd label of the bundled host agent (plist `<label>.plist`), systemd units `<label>.*`. */
  readonly hostAgentLabel: string;
  /** OS keyring services: `<prefix>.<vault|banking|classifier|connectors>.v1.<hash>`. */
  readonly keychainPrefix: string;
  /** The registered URL scheme (`<scheme>://` links). */
  readonly urlScheme: string;
  /** MCP server names `<prefix>-<profile slug>` in the setup and reconnect lines. */
  readonly mcpServerPrefix: string;
  /** TCP port of the LAN pairing listener (two flavors on one Mac must not share it). */
  readonly lanPairingPort: number;
  /** Whether the build seals the pinned release feed; false: the updater reports unavailable. */
  readonly updateFeed: boolean;
  /** Whether this flavor's default data dir is the one the retired Python app used (in-place import). */
  readonly inheritsPythonInstall: boolean;
  /**
   * A badge drawn across the app icon by packaging/icon/make_flavor_icon.swift at build time (the
   * staging app looks visibly different in the Dock), or null for the plain packaging/icon icon.
   */
  readonly iconBadge: string | null;
  /** Repo-relative packaging work dir (git-ignored). */
  readonly buildDir: string;
  /** Artifact file prefix: `<prefix>-<version>-mac-<arch>.zip`. */
  readonly artifactPrefix: string;
}

const STRING_KEYS = [
  "bundleId",
  "productName",
  "workspacesDirName",
  "hostAgentLabel",
  "keychainPrefix",
  "urlScheme",
  "mcpServerPrefix",
  "buildDir",
  "artifactPrefix",
] as const;

function load(): Readonly<Record<FlavorId, Flavor>> {
  const raw = table as { schema: unknown; flavors: Record<string, Record<string, unknown>> };
  const ids = Object.keys(raw.flavors ?? {});
  if (raw.schema !== 1 || ids.join(",") !== FLAVOR_IDS.join(","))
    throw new Error("flavor_table_invalid");
  const out = {} as Record<FlavorId, Flavor>;
  for (const id of FLAVOR_IDS) {
    const entry = raw.flavors[id] as Record<string, unknown>;
    const dataDirName = entry.dataDirName as Record<string, unknown> | undefined;
    if (
      STRING_KEYS.some((key) => typeof entry[key] !== "string" || entry[key] === "") ||
      typeof dataDirName?.darwin !== "string" ||
      typeof dataDirName.linux !== "string" ||
      !Number.isInteger(entry.lanPairingPort) ||
      typeof entry.updateFeed !== "boolean" ||
      typeof entry.inheritsPythonInstall !== "boolean" ||
      (entry.iconBadge !== null && (typeof entry.iconBadge !== "string" || entry.iconBadge === ""))
    )
      throw new Error("flavor_table_invalid");
    out[id] = Object.freeze({ id, ...(entry as Omit<Flavor, "id">) });
  }
  return Object.freeze(out);
}

/** Every flavor, keyed by id. */
export const FLAVORS: Readonly<Record<FlavorId, Flavor>> = load();

/** The flavor whose bundle ID this is; any other ID is refused. */
export function flavorForBundleId(bundleId: string): Flavor {
  for (const id of FLAVOR_IDS) if (FLAVORS[id].bundleId === bundleId) return FLAVORS[id];
  throw new Error("unknown_bundle_flavor");
}

/** The default data dir's last component on `platform` (macOS and Linux only). */
export function dataDirName(flavor: Flavor, platform: NodeJS.Platform): string {
  if (platform === "darwin") return flavor.dataDirName.darwin;
  if (platform === "linux") return flavor.dataDirName.linux;
  throw new Error("unsupported_platform");
}

/**
 * The default agent workspaces root `<home>/<name>`, like IntelliJ's `~/IdeaProjects`: outside
 * `~/Documents`, which macOS guards per app (every agent host would need its own permission).
 */
export const workspacesRoot = (flavor: Flavor, home: string) =>
  join(home, flavor.workspacesDirName);

/**
 * The earlier workspaces root `<home>/Documents/<name>` (the Python app, native builds before
 * 2026-11-08). Still the owner's files: guards refuse it like the current root.
 */
export const legacyWorkspacesRoot = (flavor: Flavor, home: string) =>
  join(home, "Documents", flavor.workspacesDirName);

/** The bundled launchd plist file name of the host agent. */
export const hostAgentPlist = (flavor: Flavor) => `${flavor.hostAgentLabel}.plist`;

/** The OS keyring service of one secret kind for one data dir hash. */
export const keychainService = (
  flavor: Flavor,
  kind: "vault" | "banking" | "classifier" | "connectors" | "relay-auth",
  hash: string,
) => `${flavor.keychainPrefix}.${kind}.v1.${hash}`;

/** The MCP server name of a profile in Claude Code. */
export const mcpServerName = (flavor: Flavor, slug: string) => `${flavor.mcpServerPrefix}-${slug}`;

/** The `.app` directory name electron-builder produces. */
export const appBundleName = (flavor: Flavor) => `${flavor.productName}.app`;

/** The flavor sealed in an app bundle: its Info.plist CFBundleIdentifier, through the table. */
export function bundleFlavor(bundlePath: string): Flavor {
  const id = execFileSync(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      join(bundlePath, "Contents", "Info.plist"),
    ],
    { encoding: "utf8", timeout: 5_000 },
  ).trim();
  return flavorForBundleId(id);
}

/**
 * The bundle a packaged process runs from: its executable is `<x>.app/Contents/MacOS/cashU` (Electron
 * main, and the host and shim run by the same binary in Node mode). Undefined for any other executable
 * (node from a checkout, the dev Electron binary).
 */
export function packagedBundleOf(execPath: string): string | undefined {
  let real: string;
  try {
    real = realpathSync.native(execPath);
  } catch {
    return undefined;
  }
  const macos = dirname(real);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  if (
    basename(real) !== "cashU" ||
    basename(macos) !== "MacOS" ||
    basename(contents) !== "Contents" ||
    !bundle.endsWith(".app")
  )
    return undefined;
  return bundle;
}

let cached: Flavor | undefined;

/**
 * This process's flavor: the sealed one of the bundle it runs from, else `prod` (source runs). Read
 * once per process; an app bundle with an unknown bundle ID throws (it must not run as either flavor).
 */
export function processFlavor(): Flavor {
  if (cached) return cached;
  const bundle = process.platform === "darwin" ? packagedBundleOf(process.execPath) : undefined;
  cached = bundle === undefined ? FLAVORS.prod : bundleFlavor(bundle);
  return cached;
}
