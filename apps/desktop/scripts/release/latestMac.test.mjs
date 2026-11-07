import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileEntry, latestMacYml, sha512Base64 } from "./latestMac.mjs";

// electron-updater's own parser and file resolution (the code an installed app runs on this file).
const updaterMain = createRequire(import.meta.url).resolve("electron-updater");
const provider = createRequire(updaterMain)("./providers/Provider.js");
const FEED = "https://github.com/Utopia-USS/cashu/releases/latest/download/";

/** MacUpdater.doDownloadUpdate's architecture filter (electron-updater 6.7.3 out/MacUpdater.js:70-77). */
function macUpdaterZip(files, isArm64Mac, arch) {
  const isArm64 = (file) => file.url.pathname.includes("arm64") || file.info.url?.includes("arm64");
  const kept =
    isArm64Mac && files.some(isArm64)
      ? files.filter((file) => isArm64Mac === isArm64(file))
      : files.filter((file) => !isArm64(file));
  // Provider.findFile prefers a url containing process.arch; replay it for the target arch.
  const zips = kept.filter((file) => file.url.pathname.endsWith(".zip"));
  return (
    zips.find((file) => [file.url.pathname, file.info.url].some((n) => n.includes(arch))) ?? zips[0]
  );
}

const dir = mkdtempSync(join(tmpdir(), "cashu-latest-mac-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function entries(version = "0.5.1") {
  const arm = join(dir, `cashU-${version}-mac-arm64.zip`);
  const x64 = join(dir, `cashU-${version}-mac-x64.zip`);
  writeFileSync(arm, "synthetic arm64 zip bytes");
  writeFileSync(x64, "synthetic x64 zip bytes, a little longer");
  return { arm64: await fileEntry(arm), x64: await fileEntry(x64) };
}

describe("latestMacYml", () => {
  it("hashes files as base64 sha512 with their byte size", async () => {
    const path = join(dir, "abc.bin");
    writeFileSync(path, "abc");
    expect(await sha512Base64(path)).toBe(
      "3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==",
    );
    expect(await fileEntry(path)).toMatchObject({ url: "abc.bin", size: 3 });
  });

  it("parses with electron-updater and lists both zips plus the legacy arm64 path", async () => {
    const { arm64, x64 } = await entries();
    const text = latestMacYml({
      version: "0.5.1",
      arm64,
      x64,
      releaseDate: "2026-11-07T10:00:00Z",
    });
    const info = provider.parseUpdateInfo(text, "latest-mac.yml", new URL(`${FEED}latest-mac.yml`));
    expect(info).toEqual({
      version: "0.5.1",
      files: [arm64, x64],
      path: arm64.url,
      sha512: arm64.sha512,
      releaseDate: "2026-11-07T10:00:00.000Z",
    });
    const resolved = provider.resolveFiles(info, new URL(FEED));
    expect(resolved.map((file) => file.url.href)).toEqual([
      `${FEED}cashU-0.5.1-mac-arm64.zip`,
      `${FEED}cashU-0.5.1-mac-x64.zip`,
    ]);
  });

  it("gives Apple silicon (also under Rosetta) the arm64 zip and Intel Macs the x64 zip", async () => {
    const { arm64, x64 } = await entries();
    const text = latestMacYml({ version: "0.5.1", arm64, x64, releaseDate: new Date() });
    const info = provider.parseUpdateInfo(text, "latest-mac.yml", new URL(`${FEED}latest-mac.yml`));
    const files = provider.resolveFiles(info, new URL(FEED));
    expect(macUpdaterZip(files, true, "arm64").info).toEqual(arm64);
    expect(macUpdaterZip(files, true, "x64").info).toEqual(arm64);
    expect(macUpdaterZip(files, false, "x64").info).toEqual(x64);
    // The real findFile on the already filtered list picks the same zip on this machine's arch.
    const intel = files.filter((file) => !file.url.pathname.includes("arm64"));
    expect(provider.findFile(intel, "zip", ["pkg", "dmg"]).info).toEqual(x64);
  });

  it("keeps the checksum and names in the shapes the app's update controller accepts", async () => {
    const { arm64, x64 } = await entries();
    const text = latestMacYml({ version: "0.5.1", arm64, x64, releaseDate: new Date() });
    const info = provider.parseUpdateInfo(text, "latest-mac.yml", new URL(`${FEED}latest-mac.yml`));
    for (const file of info.files) {
      expect(file.sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/);
      expect(file.url).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/);
    }
  });

  it("refuses names MacUpdater would route to the wrong Macs and malformed input", async () => {
    const { arm64, x64 } = await entries();
    const ok = { version: "0.5.1", arm64, x64, releaseDate: new Date() };
    expect(() =>
      latestMacYml({ ...ok, x64: { ...x64, url: "cashU-0.5.1-mac-x64-arm64.zip" } }),
    ).toThrow(/must not contain "arm64"/);
    expect(() => latestMacYml({ ...ok, arm64: { ...arm64, url: "cashU-0.5.1-mac.zip" } })).toThrow(
      /must contain "arm64"/,
    );
    expect(() => latestMacYml({ ...ok, version: "0.5" })).toThrow(/X.Y.Z/);
    expect(() => latestMacYml({ ...ok, version: "0.5.2" })).toThrow(/does not carry version/);
    expect(() => latestMacYml({ ...ok, x64: { ...x64, sha512: "abc" } })).toThrow(/sha512/);
    expect(() => latestMacYml({ ...ok, x64: { ...x64, size: 0 } })).toThrow(/size/);
    expect(() => latestMacYml({ ...ok, x64: { ...x64, url: "../cashU-0.5.1-x64.zip" } })).toThrow(
      /plain zip/,
    );
    expect(() => latestMacYml({ ...ok, x64: { ...x64, url: "cashU-0.5.1-mac-x64.dmg" } })).toThrow(
      /plain zip/,
    );
    expect(() => latestMacYml({ ...ok, releaseDate: "not a date" })).toThrow(/releaseDate/);
  });
});
