// The sealed test-build marker: Contents/Resources/test-build.json, written only by
// `apps/desktop/scripts/package-macos.mjs --test-build <json>` before the bundle manifest and the
// signature, so bundle-manifest.json lists and hashes it like every other resource. A release never
// carries it: `verify-package.mjs --release` (and so the release script) refuses a bundle that does.
//
// A packaged app honors the marker only when its bytes match the verified bundle manifest. Then, and
// only then: Electron main reads the update feed from a local `http://127.0.0.1:<port>/` server,
// accepts the configured install root instead of /Applications and runs on the configured data dir
// (also when relaunched by the updater without any environment); the host keeps agent workspaces in
// the configured workspaces dir (never ~/Documents/cashU) and maps every OS keyring service into the synthetic `cashu-next-test.<hex>` namespace
// (keyring/native.ts). Without the marker every code path is the release one.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readBundleIdentity } from "./bundleIdentity.js";
import { FLAVOR_IDS, FLAVORS } from "./flavor.js";

/** Bundle-relative path of the marker (same literal as apps/desktop/scripts/release-policy.mjs). */
export const TEST_BUILD_MARKER = "Contents/Resources/test-build.json";
const KEYS = ["schema", "kind", "feedUrl", "installRoot", "dataDir", "workspacesDir"] as const;
const FEED = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/$/;
const MAX_BYTES = 4096;

export interface TestBuildMarker {
  readonly schema: 1;
  readonly kind: "cashu-test-build";
  /** `http://127.0.0.1:<port>/`: the local feed serving latest-mac.yml and the zips. */
  readonly feedUrl: string;
  /** Canonical absolute directory the test app is installed in (never /Applications). */
  readonly installRoot: string;
  /** Canonical absolute data dir the test app must run on (never the default data dir). */
  readonly dataDir: string;
  /** Canonical absolute agent workspaces root (never ~/Documents/cashU). */
  readonly workspacesDir: string;
}

/** Every flavor's real default data dir and workspaces root names (lower case): never a test dir. */
const REAL_DATA_DIRS = new Set(
  FLAVOR_IDS.map((id) => FLAVORS[id].dataDirName.darwin.toLowerCase()),
);
const REAL_WORKSPACES = new Set(
  FLAVOR_IDS.map((id) => FLAVORS[id].workspacesDirName.toLowerCase()),
);

function invalid(): never {
  throw new Error("test_build_marker_invalid");
}

/** Never /Applications, a flavor's default data dir, its real workspaces or the root. */
function checkedDir(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || value.includes("\0")) invalid();
  if (!isAbsolute(value) || resolve(value) !== value || value === "/") invalid();
  const parts = value.split("/");
  if (parts[1] === "Applications") invalid();
  for (let index = 0; index + 2 < parts.length; index += 1) {
    if (
      parts[index] === "Library" &&
      parts[index + 1] === "Application Support" &&
      REAL_DATA_DIRS.has(parts[index + 2]?.toLowerCase() ?? "")
    )
      invalid();
  }
  for (let index = 0; index + 1 < parts.length; index += 1) {
    if (parts[index] === "Documents" && REAL_WORKSPACES.has(parts[index + 1]?.toLowerCase() ?? ""))
      invalid();
  }
  return value;
}

/** Strict parse: exact keys, a loopback http feed with a port, safe absolute directories. */
export function parseTestBuildMarker(text: string): TestBuildMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(record, key))) invalid();
  if (record.schema !== 1 || record.kind !== "cashu-test-build") invalid();
  const feed = typeof record.feedUrl === "string" ? FEED.exec(record.feedUrl) : null;
  if (!feed || Number(feed[1]) > 65_535) invalid();
  const installRoot = checkedDir(record.installRoot);
  const dataDir = checkedDir(record.dataDir);
  const workspacesDir = checkedDir(record.workspacesDir);
  const dirs = [installRoot, dataDir, workspacesDir];
  if (
    new Set(dirs).size !== dirs.length ||
    dirs.some((a) => dirs.some((b) => a !== b && b.startsWith(`${a}/`)))
  )
    invalid();
  return {
    schema: 1,
    kind: "cashu-test-build",
    feedUrl: record.feedUrl as string,
    installRoot,
    dataDir,
    workspacesDir,
  };
}

/**
 * The marker of the app bundle at `bundlePath`, or null when it has none (every release). A present
 * marker counts only when the bundle verifies and the marker's bytes match its manifest entry;
 * anything else throws, so a tampered or unverifiable test build refuses to start.
 */
export function readTestBuildMarker(bundlePath: string): TestBuildMarker | null {
  try {
    lstatSync(join(bundlePath, TEST_BUILD_MARKER));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("test_build_marker_unreadable");
  }
  const identity = readBundleIdentity(bundlePath);
  if (identity.kind !== "present") throw new Error("test_build_marker_unverified");
  const path = join(identity.canonicalPath, TEST_BUILD_MARKER);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_BYTES) invalid();
  const bytes = readFileSync(path);
  const manifest: unknown = JSON.parse(
    readFileSync(
      join(identity.canonicalPath, "Contents", "Resources", "bundle-manifest.json"),
      "utf8",
    ),
  );
  const listed = (manifest as { files?: Record<string, unknown> } | null)?.files?.[
    TEST_BUILD_MARKER
  ];
  if (typeof listed !== "string" || createHash("sha256").update(bytes).digest("hex") !== listed)
    throw new Error("test_build_marker_unverified");
  return parseTestBuildMarker(bytes.toString("utf8"));
}
