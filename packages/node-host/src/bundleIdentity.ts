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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

function contentInventory(bundle: string): string {
  const contents = join(bundle, "Contents");
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
function bundleEvidence(bundlePath: string): string | undefined {
  return rawBundleFiles(() => {
    try {
      const canonical = realpathSync(bundlePath);
      if (!canonical.endsWith(".app")) return undefined;
      const contents = join(canonical, "Contents");
      const parts = [
        resolve(bundlePath),
        canonical,
        metadata(bundlePath),
        metadata(canonical),
        metadata(join(contents, "Info.plist")),
        metadata(join(contents, "MacOS", "cashU")),
        metadata(join(contents, "MacOS", "cashu-next-host-agent")),
        metadata(join(contents, "Library", "LaunchAgents", "io.utopiasoft.cashu.next.host.plist")),
        ...inventory(contents),
      ];
      return createHash("sha256").update(parts.join("|")).digest("hex");
    } catch {
      return undefined;
    }
  });
}

/** `bundlePath` is the original .app path, not a path within its canonical target. */
const REQUIRED = [
  "Contents/Resources/host.mjs",
  "Contents/Resources/shim.mjs",
  "Contents/Resources/native/CashUNotifications.node",
  "Contents/Resources/native/CashUHostService.node",
  "Contents/Resources/notify-catalog-v1.json",
  "Contents/Resources/skills/workspace-setup/SKILL.md",
  "Contents/Resources/connectors/README.md",
  "Contents/Resources/renderer/index.html",
  "Contents/Resources/app.asar",
  "Contents/MacOS/cashu-next-host-agent",
  "Contents/Library/LaunchAgents/io.utopiasoft.cashu.next.host.plist",
] as const;

function manifestStamp(bundle: string): string {
  const manifestPath = join(bundle, "Contents", "Resources", "bundle-manifest.json");
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
  if (REQUIRED.some((path) => typeof files[path] !== "string"))
    throw new Error("manifest_missing_resource");
  const resourcePath = join(bundle, "Contents", "Resources");
  for (const absolute of regularFiles(resourcePath)) {
    if (absolute === manifestPath) continue;
    const path = relative(bundle, absolute).split(sep).join("/");
    if (!Object.hasOwn(files, path)) throw new Error("manifest_unlisted_resource");
  }
  const verified: string[] = [];
  for (const [path, expected] of Object.entries(files)) {
    if (path === "Contents/Resources/bundle-manifest.json")
      throw new Error("manifest_self_reference");
    if (
      !path.startsWith("Contents/") ||
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

export function readBundleIdentity(bundlePath: string): BundleIdentity {
  return rawBundleFiles(() => {
    try {
      const canonicalPath = realpathSync(bundlePath);
      const stat = statSync(canonicalPath);
      if (!stat.isDirectory() || !canonicalPath.endsWith(".app")) return { kind: "invalid" };
      const info = join(canonicalPath, "Contents", "Info.plist");
      const executable = join(canonicalPath, "Contents", "MacOS", "cashU");
      const verifiedManifest = manifestStamp(canonicalPath);
      const contentDigest = contentInventory(canonicalPath);
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

export function bundlePathFromEntry(entryPath: string): string | undefined {
  const resources = dirname(entryPath);
  if (resources !== join(dirname(resources), "Resources")) return undefined;
  const contents = dirname(resources);
  const appPath = dirname(contents);
  return appPath.endsWith(".app") ? appPath : undefined;
}

export function watchBundleIdentity(
  bundlePath: string,
  intervalMs: number,
  onChanged: () => void,
): () => void {
  const original = readBundleIdentity(bundlePath);
  if (original.kind !== "present") throw new Error("bundle_identity_unavailable");
  const originalEvidence = bundleEvidence(bundlePath);
  if (!originalEvidence) throw new Error("bundle_identity_unavailable");
  const timer = setInterval(() => {
    if (bundleEvidence(bundlePath) === originalEvidence) return;
    // Any changed evidence is a handover boundary. Reverify content before reporting it.
    readBundleIdentity(bundlePath);
    clearInterval(timer);
    onChanged();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
