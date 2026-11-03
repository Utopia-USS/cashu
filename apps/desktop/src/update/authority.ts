import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import type { UpdateAuthority } from "./controller.js";
import { RELEASE_FEED_URL, RELEASE_TEAM_ID } from "./releasePolicy.js";

const APP_ID = "io.utopiasoft.cashu.next";

export function developerIdRequirement(teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("invalid_team_id");
  return `=anchor apple generic and identifier "${APP_ID}" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${teamId}"`;
}

export interface InstalledApp {
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly resourcesPath: string;
  readonly dataDir: string;
  readonly expectedDataDir: string;
}

/** Rejects duplicate YAML keys, aliases, extra fields and credentials or URL redirection. */
export function parseReleaseFeed(source: string, expectedUrl: string): boolean {
  try {
    const doc = parseDocument(source, { strict: true, uniqueKeys: true });
    if (doc.errors.length !== 0) return false;
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const fields = value as Record<string, unknown>;
    if (
      Object.keys(fields).some((key) => !["provider", "url", "updaterCacheDirName"].includes(key))
    )
      return false;
    if (
      fields.provider !== "generic" ||
      typeof fields.url !== "string" ||
      fields.url !== expectedUrl
    )
      return false;
    if (
      fields.updaterCacheDirName !== undefined &&
      (typeof fields.updaterCacheDirName !== "string" ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(fields.updaterCacheDirName))
    )
      return false;
    const url = new URL(fields.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !url.hostname.includes(".")
    )
      return false;
    if (url.toString() !== expectedUrl) return false;
    return true;
  } catch {
    return false;
  }
}

function inside(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** Validates the installed app's sealed release config, macOS signing identity and location. */
function installedUpdateGate(
  app: InstalledApp,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (process.platform !== "darwin" || !app.isPackaged)
    return { ok: false, reason: "not_packaged_macos" };
  if (!RELEASE_TEAM_ID || !/^[A-Z0-9]{10}$/.test(RELEASE_TEAM_ID) || !RELEASE_FEED_URL)
    return { ok: false, reason: "release_policy_unset" };
  try {
    const executable = realpathSync(app.execPath);
    const contents = dirname(dirname(executable));
    const bundle = dirname(contents);
    if (!bundle.endsWith(".app") || executable !== join(bundle, "Contents", "MacOS", "cashU"))
      return { ok: false, reason: "bundle_identity" };
    const resource = realpathSync(app.resourcesPath);
    if (resource !== join(contents, "Resources") || !inside(bundle, resource))
      return { ok: false, reason: "bundle_resources" };
    const translocated = bundle.includes("/AppTranslocation/");
    if (translocated || !bundle.startsWith("/Applications/"))
      return { ok: false, reason: "install_location" };
    if (realpathSync(app.dataDir) !== realpathSync(app.expectedDataDir))
      return { ok: false, reason: "data_dir_mismatch" };
    const identifier = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print CFBundleIdentifier", join(contents, "Info.plist")],
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
    if (identifier !== APP_ID) return { ok: false, reason: "bundle_id" };
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
      stdio: "ignore",
      timeout: 10_000,
    });
    const requirement = developerIdRequirement(RELEASE_TEAM_ID);
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, bundle], {
      stdio: "ignore",
      timeout: 10_000,
    });
    const feed = join(resource, "app-update.yml");
    const fd = openSync(feed, constants.O_RDONLY | constants.O_NOFOLLOW);
    let feedText: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 16_384) return { ok: false, reason: "feed_config" };
      const bytes = Buffer.alloc(16_385);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, count);
        if (read === 0) break;
        count += read;
      }
      if (count > 16_384) return { ok: false, reason: "feed_config" };
      feedText = bytes.subarray(0, count).toString("utf8");
    } finally {
      closeSync(fd);
    }
    if (!parseReleaseFeed(feedText, RELEASE_FEED_URL)) return { ok: false, reason: "feed_config" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "identity_unknown" };
  }
}

/** `handover` is supplied by main after it has genuine host and sidecar lifecycle handles. */
export function releaseAuthority(
  app: InstalledApp,
  handover: UpdateAuthority["handover"],
): UpdateAuthority {
  return { check: async () => installedUpdateGate(app), handover };
}
