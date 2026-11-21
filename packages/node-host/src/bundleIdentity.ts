// The verified identity of a packaged build: a macOS `.app` bundle, or a Windows install dir
// (`<install>\cashU.exe`, `<install>\resources\{host.mjs, shim.mjs, app.asar, app-identity.json,
// bundle-manifest.json, ...}`, written by package-windows.mjs). Both are checked the same way: a manifest
// (`bundle-manifest.json`) lists and hashes every regular resource file, a content digest covers every
// file of the bundle (links must stay inside it, absolute links and special files are refused), and the
// fingerprint binds the paths, the identity record (Info.plist / app-identity.json), the main
// executable, the verified manifest and the content digest. Every function takes the platform whose
// layout applies (default: this process's); any platform but Windows uses the macOS layout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  FLAVOR_IDS,
  FLAVORS,
  hostAgentPlist,
  readAppIdentity,
  WINDOWS_APP_IDENTITY,
  WINDOWS_EXECUTABLE,
} from "./flavor.js";

// Electron virtualizes app.asar as a directory in fs. Bundle identity hashes the actual archive
// and must see the same regular-file inventory as a plain Node process. Calls below are sync.
function rawBundleFiles<T>(read: () => T): T {
  const runtime = process as NodeJS.Process & { noAsar?: boolean };
  const hadOwn = Object.hasOwn(runtime, "noAsar");
  const previous = runtime.noAsar;
  runtime.noAsar = true;
  try {
    return read();
  } finally {
    if (hadOwn) runtime.noAsar = previous;
    else Reflect.deleteProperty(runtime, "noAsar");
  }
}

/** A missing or moved bundle is a replacement, even when host.mjs did not change. */
export type BundleIdentity =
  | { readonly kind: "invalid" }
  | {
      readonly kind: "present";
      readonly canonicalPath: string;
      readonly fingerprint: string;
      readonly contentDigest: string;
    };

/** Stable across an exact app copy; changes when sealed resources, Info or the main executable change. */
export function packagedBuildId(version: string, contentDigest: string): string {
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
    !/^[a-f0-9]{64}$/.test(contentDigest) ||
    `desktop-${version}-${contentDigest}`.length > 128
  )
    throw new Error("invalid_packaged_build_identity");
  return `desktop-${version}-${contentDigest}`;
}

function stamp(path: string, contentHash = true): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("not_a_file");
  const hash = contentHash ? hashFile(path) : "";
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${hash}`;
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function metadata(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  const target = stat.isSymbolicLink() ? realpathSync(path) : "";
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${target}`;
}

function inventory(path: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      out.push(`${file}:${metadata(file)}`);
      if (lstatSync(file).isDirectory()) visit(file);
    }
  };
  visit(path);
  return out;
}

function regularFiles(path: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) out.push(file);
    }
  };
  visit(path);
  return out;
}

function contentInventory(bundle: string, layout: Layout): string {
  const contents = layout.contentRoot(bundle);
  const records: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      const path = relative(bundle, file).split(sep).join("/");
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) records.push(JSON.stringify(["file", path, hashFile(file)]));
      else if (stat.isSymbolicLink()) {
        const link = readlinkSync(file);
        if (isAbsolute(link)) throw new Error("bundle_absolute_link");
        const target = realpathSync.native(file);
        const rel = relative(contents, target);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
          throw new Error("bundle_link_escape");
        records.push(JSON.stringify(["link", path, link]));
      } else throw new Error("bundle_special_file");
    }
  };
  visit(contents);
  return createHash("sha256").update(records.sort().join("\n")).digest("hex");
}

/** Cheap steady-state watch evidence; ctime catches content writes with restored mtime. */
function bundleEvidence(bundlePath: string, layout: Layout): string | undefined {
  return rawBundleFiles(() => {
    try {
      const canonical = layout.canonical(bundlePath);
      if (!layout.isRoot(canonical)) return undefined;
      const parts = [
        resolve(bundlePath),
        canonical,
        metadata(bundlePath),
        metadata(canonical),
        metadata(layout.info(canonical)),
        metadata(layout.executable(canonical)),
        ...layout.evidence(canonical).map(metadata),
        ...inventory(layout.contentRoot(canonical)),
      ];
      return createHash("sha256").update(parts.join("|")).digest("hex");
    } catch {
      return undefined;
    }
  });
}

/** The resources every macOS bundle manifest lists (bundle-relative). */
const MAC_REQUIRED = [
  "Contents/Resources/host.mjs",
  "Contents/Resources/shim.mjs",
  "Contents/Resources/native/CashUNotifications.node",
  "Contents/Resources/native/CashUHostService.node",
  "Contents/Resources/notify-catalog-v1.json",
  "Contents/Resources/skills/workspace-setup/SKILL.md",
  "Contents/Resources/connectors/README.md",
  "Contents/Resources/renderer/index.html",
  "Contents/Resources/app.asar",
  "Contents/MacOS/cashu-host-agent",
] as const;

/** The host agent plist of each flavor; a bundle carries exactly one (its own flavor's). */
const AGENT_PLISTS = FLAVOR_IDS.map(
  (id) => `Contents/Library/LaunchAgents/${hostAgentPlist(FLAVORS[id])}`,
);

/**
 * The resources every Windows install manifest lists (install-relative). No native addons, host
 * agent or launch agent plist exist on Windows; the identity record is a listed resource.
 */
const WINDOWS_REQUIRED = [
  "resources/host.mjs",
  "resources/shim.mjs",
  "resources/notify-catalog-v1.json",
  "resources/skills/workspace-setup/SKILL.md",
  "resources/connectors/README.md",
  "resources/renderer/index.html",
  "resources/app.asar",
  WINDOWS_APP_IDENTITY,
] as const;

/** How one platform lays out a packaged build. Paths are absolute, under the canonical root. */
interface Layout {
  /** The canonical path of a bundle path (follows links). */
  canonical(path: string): string;
  /** Whether a canonical directory can be a bundle root at all. */
  isRoot(canonical: string): boolean;
  /** The directory the content digest and the watch inventory cover. */
  contentRoot(root: string): string;
  /** The directory holding host.mjs, shim.mjs and the bundle manifest. */
  resources(root: string): string;
  /** The main executable (Electron main, and the host and shim in Node mode). */
  executable(root: string): string;
  /** The identity record (bundle ID and version), hashed into the fingerprint. */
  info(root: string): string;
  /** Extra files whose metadata is watch evidence. */
  evidence(root: string): string[];
  /** Root-relative prefix of every manifest key. */
  readonly manifestPrefix: string;
  /** Manifest keys that must be present. */
  readonly required: readonly string[];
  /** Extra shape checks of the listed files (macOS: exactly one host agent plist). */
  checkListed(files: Readonly<Record<string, unknown>>): void;
  /** Platform-specific checks of the identity record beyond its manifest hash. */
  checkInfo(root: string): void;
}

const MAC_LAYOUT: Layout = {
  canonical: (path) => realpathSync(path),
  isRoot: (canonical) => canonical.endsWith(".app"),
  contentRoot: (root) => join(root, "Contents"),
  resources: (root) => join(root, "Contents", "Resources"),
  executable: (root) => join(root, "Contents", "MacOS", "cashU"),
  info: (root) => join(root, "Contents", "Info.plist"),
  evidence: (root) => [
    join(root, "Contents", "MacOS", "cashu-host-agent"),
    ...AGENT_PLISTS.map((path) => join(root, path)).filter((path) => lstatOrNull(path) !== null),
  ],
  manifestPrefix: "Contents/",
  required: MAC_REQUIRED,
  checkListed(files) {
    if (AGENT_PLISTS.filter((path) => typeof files[path] === "string").length !== 1)
      throw new Error("manifest_missing_resource");
  },
  checkInfo: () => {},
};

const WINDOWS_LAYOUT: Layout = {
  // The native realpath returns the on-disk case, the form `realpathSync.native` callers compare.
  canonical: (path) => realpathSync.native(path),
  isRoot: () => true,
  contentRoot: (root) => root,
  resources: (root) => join(root, "resources"),
  executable: (root) => join(root, WINDOWS_EXECUTABLE),
  info: (root) => join(root, ...WINDOWS_APP_IDENTITY.split("/")),
  evidence: () => [],
  manifestPrefix: "resources/",
  required: WINDOWS_REQUIRED,
  checkListed: () => {},
  checkInfo(root) {
    readAppIdentity(root);
  },
};

const layoutOf = (platform: NodeJS.Platform): Layout =>
  platform === "win32" ? WINDOWS_LAYOUT : MAC_LAYOUT;

/** Where a packaged build keeps its resources and its main executable, on `platform`. */
export interface PackagedLayout {
  /** `<x>.app/Contents/Resources`, or `<install>/resources` on Windows. */
  readonly resources: string;
  /** `<x>.app/Contents/MacOS/cashU`, or `<install>/cashU.exe` on Windows. */
  readonly executable: string;
}

/** The layout of the packaged build rooted at `root` (a canonical bundle path). */
export function packagedLayout(
  root: string,
  platform: NodeJS.Platform = process.platform,
): PackagedLayout {
  const layout = layoutOf(platform);
  return { resources: layout.resources(root), executable: layout.executable(root) };
}

/**
 * The app version sealed in the bundle at `root`: CFBundleShortVersionString of its Info.plist
 * (macOS), the `version` of `resources/app-identity.json` (Windows). Call it after
 * `readBundleIdentity` verified the bundle.
 */
export function packagedVersion(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return readAppIdentity(root).version;
  return execFileSync(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      join(root, "Contents", "Info.plist"),
    ],
    { encoding: "utf8", timeout: 5_000 },
  ).trim();
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function manifestStamp(bundle: string, layout: Layout): string {
  const manifestPath = join(layout.resources(bundle), "bundle-manifest.json");
  const manifestKey = relative(bundle, manifestPath).split(sep).join("/");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > 4 * 1024 * 1024)
    throw new Error("manifest_too_large");
  const raw = readFileSync(manifestPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("manifest_shape");
  const record = parsed as Record<string, unknown>;
  if (
    record.schema !== 1 ||
    !record.files ||
    typeof record.files !== "object" ||
    Array.isArray(record.files)
  )
    throw new Error("manifest_shape");
  if (Object.keys(record).some((key) => !["schema", "files"].includes(key)))
    throw new Error("manifest_shape");
  const files = record.files as Record<string, unknown>;
  if (Object.keys(files).length > 20_000) throw new Error("manifest_too_many_files");
  if (layout.required.some((path) => typeof files[path] !== "string"))
    throw new Error("manifest_missing_resource");
  layout.checkListed(files);
  const resourcePath = layout.resources(bundle);
  for (const absolute of regularFiles(resourcePath)) {
    if (absolute === manifestPath) continue;
    const path = relative(bundle, absolute).split(sep).join("/");
    if (!Object.hasOwn(files, path)) throw new Error("manifest_unlisted_resource");
  }
  const verified: string[] = [];
  for (const [path, expected] of Object.entries(files)) {
    if (path === manifestKey) throw new Error("manifest_self_reference");
    if (
      !path.startsWith(layout.manifestPrefix) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      isAbsolute(path) ||
      typeof expected !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected)
    )
      throw new Error("manifest_resource");
    const absolute = realpathSync(join(bundle, path));
    const rel = relative(bundle, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("manifest_escape");
    const stat = statSync(absolute);
    if (!stat.isFile()) throw new Error("manifest_not_file");
    const actual = hashFile(absolute);
    if (actual !== expected) throw new Error("manifest_hash");
    verified.push(`${path}:${stamp(absolute, false)}:${actual}`);
  }
  return `${stamp(manifestPath)}:${verified.sort().join("|")}`;
}

/**
 * The verified identity of the packaged build at `bundlePath` (a `.app` on macOS, the install dir on
 * Windows), or `invalid` when anything does not verify.
 */
export function readBundleIdentity(
  bundlePath: string,
  platform: NodeJS.Platform = process.platform,
): BundleIdentity {
  const layout = layoutOf(platform);
  return rawBundleFiles(() => {
    try {
      const canonicalPath = layout.canonical(bundlePath);
      const stat = statSync(canonicalPath);
      if (!stat.isDirectory() || !layout.isRoot(canonicalPath)) return { kind: "invalid" };
      const info = layout.info(canonicalPath);
      const executable = layout.executable(canonicalPath);
      layout.checkInfo(canonicalPath);
      const verifiedManifest = manifestStamp(canonicalPath, layout);
      const contentDigest = contentInventory(canonicalPath, layout);
      const fingerprint = createHash("sha256")
        .update(
          [
            resolve(bundlePath),
            canonicalPath,
            `${stat.dev}:${stat.ino}`,
            stamp(info),
            stamp(executable, false),
            verifiedManifest,
            contentDigest,
          ].join("|"),
        )
        .digest("hex");
      return { kind: "present", canonicalPath, fingerprint, contentDigest };
    } catch {
      return { kind: "invalid" };
    }
  });
}

/**
 * The bundle of a packaged entry file (host.mjs, shim.mjs): `<x>.app` of
 * `<x>.app/Contents/Resources/<entry>` on macOS, `<install>` of `<install>/resources/<entry>` on
 * Windows. Path shape only; `readBundleIdentity` verifies it.
 */
export function bundlePathFromEntry(
  entryPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const resources = dirname(entryPath);
  if (platform === "win32") {
    // NTFS names are case-insensitive; electron-builder writes `resources`.
    if (basename(resources).toLowerCase() !== "resources" || dirname(resources) === resources)
      return undefined;
    return dirname(resources);
  }
  if (resources !== join(dirname(resources), "Resources")) return undefined;
  const contents = dirname(resources);
  const appPath = dirname(contents);
  return appPath.endsWith(".app") ? appPath : undefined;
}

export function watchBundleIdentity(
  bundlePath: string,
  intervalMs: number,
  onChanged: () => void,
  platform: NodeJS.Platform = process.platform,
): () => void {
  const layout = layoutOf(platform);
  const original = readBundleIdentity(bundlePath, platform);
  if (original.kind !== "present") throw new Error("bundle_identity_unavailable");
  const originalEvidence = bundleEvidence(bundlePath, layout);
  if (!originalEvidence) throw new Error("bundle_identity_unavailable");
  const timer = setInterval(() => {
    if (bundleEvidence(bundlePath, layout) === originalEvidence) return;
    // Any changed evidence is a handover boundary. Reverify content before reporting it.
    readBundleIdentity(bundlePath, platform);
    clearInterval(timer);
    onChanged();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
