import { expect, it } from "vitest";
import {
  developerIdRequirement,
  parseReleaseFeed,
  parseTestBuildFeed,
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
