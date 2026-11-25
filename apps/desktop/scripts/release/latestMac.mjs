// latest-mac.yml for electron-updater (generic provider): the update metadata of one native macOS release.
//
// Installed apps fetch `<RELEASE_FEED_URL>latest-mac.yml`, pick the zip for their architecture and check its
// sha512 before installing. electron-updater's MacUpdater keeps the files whose url contains "arm64" on Apple
// silicon and the files without "arm64" everywhere else (MacUpdater.js, `isArm64`), then takes the zip
// (Provider.js `findFile`). So the arm64 zip name must contain "arm64" and the x64 zip name must not.
// `path` + `sha512` at the top level repeat the arm64 zip for clients that read only the legacy fields.
//
// Node built-ins only (run by apps/desktop/scripts/release-macos.mjs from a plain export of the release commit).
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
// The same file name and checksum shapes the app's update controller accepts (src/update/controller.ts).
const ZIP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;
const SHA512_RE = /^[A-Za-z0-9+/]{86}==$/;

/** Base64 sha512 of a file, the checksum format electron-updater verifies. */
export function sha512Base64(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha512");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("base64")));
  });
}

/** `{ url, sha512, size }` of one artifact; the url is the bare file name (resolved against the feed base). */
export async function fileEntry(path) {
  return { url: basename(path), sha512: await sha512Base64(path), size: statSync(path).size };
}

function checkEntry(entry, label, version) {
  if (!entry || typeof entry !== "object") throw new Error(`${label}: missing file entry`);
  const { url, sha512, size } = entry;
  if (typeof url !== "string" || !ZIP_NAME_RE.test(url) || url.includes(".."))
    throw new Error(`${label}: not a plain zip file name: ${url}`);
  if (!url.includes(`-${version}-`))
    throw new Error(`${label}: ${url} does not carry version ${version}`);
  if (typeof sha512 !== "string" || !SHA512_RE.test(sha512))
    throw new Error(`${label}: sha512 is not a base64 sha512`);
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error(`${label}: size must be a positive integer`);
}

function quoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * The latest-mac.yml text for one release with a separate arm64 and x64 zip.
 * @param {{ version: string, arm64: {url: string, sha512: string, size: number},
 *           x64: {url: string, sha512: string, size: number}, releaseDate: Date | string }} input
 */
export function latestMacYml({ version, arm64, x64, releaseDate }) {
  if (typeof version !== "string" || !VERSION_RE.test(version))
    throw new Error(`version must be X.Y.Z: ${version}`);
  checkEntry(arm64, "arm64", version);
  checkEntry(x64, "x64", version);
  if (!arm64.url.includes("arm64")) throw new Error(`arm64: ${arm64.url} must contain "arm64"`);
  // MacUpdater would offer an x64 zip named "...arm64..." to Apple silicon only, and none to Intel Macs.
  if (x64.url.includes("arm64")) throw new Error(`x64: ${x64.url} must not contain "arm64"`);
  if (arm64.url === x64.url) throw new Error("arm64 and x64 zips must differ");
  const date = releaseDate instanceof Date ? releaseDate : new Date(releaseDate);
  if (Number.isNaN(date.getTime())) throw new Error(`releaseDate is not a date: ${releaseDate}`);
  const file = (entry) =>
    [
      `  - url: ${quoted(entry.url)}`,
      `    sha512: ${quoted(entry.sha512)}`,
      `    size: ${entry.size}`,
    ].join("\n");
  return [
    `version: ${quoted(version)}`,
    "files:",
    file(arm64),
    file(x64),
    `path: ${quoted(arm64.url)}`,
    `sha512: ${quoted(arm64.sha512)}`,
    `releaseDate: ${quoted(date.toISOString())}`,
    "",
  ].join("\n");
}
