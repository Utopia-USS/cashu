// The release policy the packaging scripts seal into a build. The single source of truth is
// src/update/releasePolicy.ts (compiled into main.js, read by the update authority); this module
// parses that file instead of repeating the team ID or the feed URL, so the sealed
// Contents/Resources/app-update.yml and the compiled gate can never disagree. A later test-only
// update build substitutes the policy at this one seam; verify-package --release refuses any app
// whose sealed feed or compiled constants differ from the policy in releasePolicy.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const APP_ID = "io.utopiasoft.cashu";
/** electron-updater's download cache: ~/Library/Caches/<name>. Fixed so updates never collide. */
export const UPDATER_CACHE_DIR_NAME = "cashu-updater";

function constant(source, name) {
  const pattern = new RegExp(
    `^export const ${name}: string \\| null =\\s*(null|"([^"\\\\\\n]*)");$`,
    "gm",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`releasePolicy.ts: expected one ${name}`);
  return matches[0][1] === "null" ? null : matches[0][2];
}

/** Reads { teamId, feedUrl } from apps/desktop/src/update/releasePolicy.ts; null when unset. */
export function readReleasePolicy(root) {
  const source = readFileSync(join(root, "apps/desktop/src/update/releasePolicy.ts"), "utf8");
  const teamId = constant(source, "RELEASE_TEAM_ID");
  const feedUrl = constant(source, "RELEASE_FEED_URL");
  if (teamId !== null && !/^[A-Z0-9]{10}$/.test(teamId))
    throw new Error("releasePolicy.ts: RELEASE_TEAM_ID is not a team ID");
  if (feedUrl !== null) {
    const url = new URL(feedUrl);
    if (url.protocol !== "https:" || url.toString() !== feedUrl || !feedUrl.endsWith("/"))
      throw new Error("releasePolicy.ts: RELEASE_FEED_URL must be a canonical https base URL");
  }
  return { teamId, feedUrl };
}

/** The sealed electron-updater config (generic provider); the authority accepts exactly this. */
export function appUpdateYml(policy) {
  if (!policy.feedUrl) throw new Error("Release feed URL is not pinned");
  return `provider: generic\nurl: ${policy.feedUrl}\nupdaterCacheDirName: ${UPDATER_CACHE_DIR_NAME}\n`;
}

/** The team ID in "Developer ID Application: <name> (<TEAMID>)"; never auto-discovered. */
export function developerIdTeam(identity) {
  const match = /^Developer ID Application: [^\n]+ \(([A-Z0-9]{10})\)$/.exec(identity ?? "");
  if (!match) throw new Error('--sign expects "Developer ID Application: <name> (<TEAMID>)"');
  return match[1];
}

/** Same designated requirement as src/update/authority.ts developerIdRequirement (tested). */
export function developerIdRequirement(teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("invalid_team_id");
  return `=anchor apple generic and identifier "${APP_ID}" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${teamId}"`;
}

/** Stable artifact names; the x64 name never contains "arm64" (MacUpdater picks by that). */
export function artifactName(version, arch, extension) {
  if (!["arm64", "x64"].includes(arch) || !["zip", "dmg"].includes(extension))
    throw new Error("Unexpected artifact");
  return `cashU-${version}-mac-${arch}.${extension}`;
}
