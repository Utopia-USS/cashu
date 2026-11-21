import { FLAVORS } from "@cashu/node-host/flavor";
import { expect, it } from "vitest";
import {
  developerIdRequirement,
  installsUpdatesByHand,
  parseReleaseFeed,
  parseTestBuildFeed,
  releaseAuthority,
  TEST_UPDATER_CACHE_DIR_NAME,
} from "./authority.js";

const url = "https://updates.example.test/cashu/";
it("requires one exact, credential-free generic feed URL", () => {
  expect(
    parseReleaseFeed(`provider: generic\nurl: ${url}\nupdaterCacheDirName: cashu\n`, url),
  ).toBe(true);
  expect(
    parseReleaseFeed(`provider: generic\nurl: ${url}\nurl: https://evil.example.test/\n`, url),
  ).toBe(false);
  expect(parseReleaseFeed(`provider: generic\nprovider: github\nurl: ${url}\n`, url)).toBe(false);
  expect(
    parseReleaseFeed(
      `provider: generic\nurl: https://name:secret@updates.example.test/cashu/\n`,
      url,
    ),
  ).toBe(false);
  expect(
    parseReleaseFeed(`provider: generic\nurl: ${url}\nheaders: {Authorization: secret}\n`, url),
  ).toBe(false);
});

it("refuses a feed that is not a mapping or has a malformed cache dir name", () => {
  expect(parseReleaseFeed(`provider: generic\nurl: ${url}\n`, url)).toBe(true);
  expect(parseReleaseFeed(`- provider: generic\n- url: ${url}\n`, url)).toBe(false);
  expect(parseReleaseFeed("generic\n", url)).toBe(false);
  expect(parseReleaseFeed(`url: ${url}\n`, url)).toBe(false);
  expect(parseReleaseFeed(`provider: generic\nurl: ${url}\nupdaterCacheDirName:\n`, url)).toBe(
    false,
  );
  expect(
    parseReleaseFeed(`provider: generic\nurl: ${url}\nupdaterCacheDirName: ../escape\n`, url),
  ).toBe(false);
  expect(parseReleaseFeed(`provider: generic\nurl: 42\n`, url)).toBe(false);
});

it("pins the Apple Developer ID requirement to the app ID and release team", () => {
  const requirement = developerIdRequirement("ABCDE12345");
  expect(requirement).toContain('identifier "io.utopiasoft.cashu"');
  expect(requirement).toContain("anchor apple generic");
  expect(requirement).toContain("1.2.840.113635.100.6.1.13");
  expect(requirement).toContain('certificate leaf[subject.OU] = "ABCDE12345"');
  expect(() => developerIdRequirement("$(bad)")).toThrow("invalid_team_id");
});

it("accepts a test build's local feed only through the test parser", () => {
  const local = "http://127.0.0.1:47123/";
  const yml = (feed: string, cache = TEST_UPDATER_CACHE_DIR_NAME) =>
    `provider: generic\nurl: ${feed}\nupdaterCacheDirName: ${cache}\n`;
  expect(parseTestBuildFeed(yml(local), local)).toBe(true);
  // The release parser never accepts it: a release keeps https-only, port-free feeds.
  expect(parseReleaseFeed(yml(local), local)).toBe(false);
  expect(parseTestBuildFeed(yml(local, "cashu-updater"), local)).toBe(false);
  expect(parseTestBuildFeed(`provider: generic\nurl: ${local}\n`, local)).toBe(false);
  expect(parseTestBuildFeed(yml(local), "http://127.0.0.1:47124/")).toBe(false);
  for (const feed of [
    "http://localhost:47123/",
    "http://127.0.0.2:47123/",
    "https://127.0.0.1:47123/",
    "http://127.0.0.1/",
    "http://127.0.0.1:47123/feed/",
    "http://user:pw@127.0.0.1:47123/",
    url,
  ])
    expect(parseTestBuildFeed(yml(feed), feed)).toBe(false);
  expect(parseTestBuildFeed(`${yml(local)}url: http://127.0.0.1:1/\n`, local)).toBe(false);
});

it("never offers updates in a flavor without an update feed (the staging app)", async () => {
  const authority = releaseAuthority(
    {
      platform: "darwin",
      isPackaged: true,
      execPath: "/synthetic/cashU Staging.app/Contents/MacOS/cashU",
      resourcesPath: "/synthetic/cashU Staging.app/Contents/Resources",
      dataDir: "/synthetic/data",
      expectedDataDir: "/synthetic/data",
      flavor: FLAVORS.staging,
    },
    async () => {
      throw new Error("no handover");
    },
  );
  expect(await authority.check()).toEqual({ ok: false, reason: "flavor_without_updates" });
});

const noHandover = async (): Promise<never> => {
  throw new Error("no handover");
};
const windowsInstall = {
  platform: "win32",
  isPackaged: true,
  execPath: "C:\\synthetic\\Programs\\cashu\\cashU.exe",
  resourcesPath: "C:\\synthetic\\Programs\\cashu\\resources",
  dataDir: "C:\\synthetic\\Local\\cashU",
  expectedDataDir: "C:\\synthetic\\Local\\cashU",
  flavor: FLAVORS.prod,
} as const;

it("leaves a packaged Windows install to manual updates, before any macOS signing check", async () => {
  expect(installsUpdatesByHand(windowsInstall)).toBe(true);
  // No codesign, PlistBuddy or feed file is consulted: the reason is decided by the platform alone.
  expect(await releaseAuthority(windowsInstall, noHandover).check()).toEqual({
    ok: false,
    reason: "windows_manual_update",
  });
});

it("keeps the other refusals for builds that are not a packaged Windows release", async () => {
  const dev = { ...windowsInstall, isPackaged: false };
  expect(installsUpdatesByHand(dev)).toBe(false);
  expect(await releaseAuthority(dev, noHandover).check()).toEqual({
    ok: false,
    reason: "not_packaged_macos",
  });
  const staging = { ...windowsInstall, flavor: FLAVORS.staging };
  expect(installsUpdatesByHand(staging)).toBe(false);
  expect(await releaseAuthority(staging, noHandover).check()).toEqual({
    ok: false,
    reason: "flavor_without_updates",
  });
  const linux = { ...windowsInstall, platform: "linux" as const };
  expect(installsUpdatesByHand(linux)).toBe(false);
  expect(await releaseAuthority(linux, noHandover).check()).toEqual({
    ok: false,
    reason: "not_packaged_macos",
  });
  expect(installsUpdatesByHand({ ...windowsInstall, platform: "darwin" })).toBe(false);
});
