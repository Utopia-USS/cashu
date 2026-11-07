import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { UpdateAuthority } from "./controller.js";
import { RELEASE_FEED_URL, RELEASE_TEAM_ID } from "./releasePolicy.js";

const APP_ID = "io.utopiasoft.cashu";

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
  /**
   * Only from a sealed, manifest-verified test-build marker (@cashu/node-host/test-build): the
   * local feed the sealed app-update.yml must name and the install root that replaces
   * /Applications. Absent in every release, where the pinned policy alone decides.
   */
  readonly testBuild?: { readonly feedUrl: string; readonly installRoot: string };
}

const releaseFeedSchema = z.strictObject({
  provider: z.literal("generic"),
  url: z.string(),
  updaterCacheDirName: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,80}$/)
    .optional(),
});

/** Rejects duplicate YAML keys, aliases, extra fields and credentials or URL redirection. */
export function parseReleaseFeed(source: string, expectedUrl: string): boolean {
  try {
    const doc = parseDocument(source, { strict: true, uniqueKeys: true });
    if (doc.errors.length !== 0) return false;
    const parsed = releaseFeedSchema.safeParse(doc.toJS({ maxAliasCount: 0 }));
    if (!parsed.success || parsed.data.url !== expectedUrl) return false;
    const url = new URL(parsed.data.url);
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

/** The cache dir a test build's sealed app-update.yml names (never the release cache). */
export const TEST_UPDATER_CACHE_DIR_NAME = "cashu-updater-test";

/**
 * A sealed test build's feed: the same strict YAML as parseReleaseFeed, but exactly
 * `http://127.0.0.1:<port>/` and the test cache dir. Used only when the verified bundle carries the
 * test-build marker; a release never reaches this parser.
 */
export function parseTestBuildFeed(source: string, expectedUrl: string): boolean {
  try {
    const doc = parseDocument(source, { strict: true, uniqueKeys: true });
    if (doc.errors.length !== 0) return false;
    const parsed = releaseFeedSchema.safeParse(doc.toJS({ maxAliasCount: 0 }));
    if (
      !parsed.success ||
      parsed.data.url !== expectedUrl ||
      parsed.data.updaterCacheDirName !== TEST_UPDATER_CACHE_DIR_NAME
    )
      return false;
    const url = new URL(parsed.data.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !/^[1-9][0-9]{3,4}$/.test(url.port) ||
      Number(url.port) > 65_535 ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return false;
    return url.toString() === expectedUrl;
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
    const test = app.testBuild;
    if (
      translocated ||
      (test
        ? bundle === test.installRoot || !inside(realpathSync(test.installRoot), bundle)
        : !bundle.startsWith("/Applications/"))
    )
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
    if (
      test
        ? !parseTestBuildFeed(feedText, test.feedUrl)
        : !parseReleaseFeed(feedText, RELEASE_FEED_URL)
    )
      return { ok: false, reason: "feed_config" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "identity_unknown" };
  }
}

/** `handover` is supplied by main after it has genuine host lifecycle handles. */
export function releaseAuthority(
  app: InstalledApp,
  handover: UpdateAuthority["handover"],
): UpdateAuthority {
  return { check: async () => installedUpdateGate(app), handover };
}
