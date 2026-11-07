import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTestBuildMarker } from "@cashu/node-host/test-build";
import { afterEach, expect, it } from "vitest";
import {
  developerIdRequirement as authorityRequirement,
  parseReleaseFeed,
  parseTestBuildFeed,
} from "../src/update/authority.ts";
import { RELEASE_FEED_URL, RELEASE_TEAM_ID } from "../src/update/releasePolicy.ts";
import {
  APP_ID,
  appUpdateYml,
  artifactName,
  assertNoTestBuild,
  developerIdRequirement,
  developerIdTeam,
  parseTestBuild,
  readReleasePolicy,
  readTestBuild,
  TEST_BUILD_MARKER,
  testAppUpdateYml,
  testBuildJson,
  UPDATER_CACHE_DIR_NAME,
} from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temps = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fakeRoot(source) {
  const dir = mkdtempSync(join(tmpdir(), "cashu-release-policy-"));
  temps.push(dir);
  mkdirSync(join(dir, "apps/desktop/src/update"), { recursive: true });
  writeFileSync(join(dir, "apps/desktop/src/update/releasePolicy.ts"), source);
  return dir;
}

it("pins the owner's production team and GitHub Releases feed", () => {
  expect(RELEASE_TEAM_ID).toBe("29W838VKU4");
  expect(RELEASE_FEED_URL).toBe("https://github.com/Utopia-USS/cashu/releases/latest/download/");
});

it("reads the same policy the compiled gate uses and seals a feed the authority accepts", () => {
  const policy = readReleasePolicy(root);
  expect(policy).toEqual({ teamId: RELEASE_TEAM_ID, feedUrl: RELEASE_FEED_URL });
  const yml = appUpdateYml(policy);
  expect(yml).toBe(
    `provider: generic\nurl: ${RELEASE_FEED_URL}\nupdaterCacheDirName: ${UPDATER_CACHE_DIR_NAME}\n`,
  );
  expect(parseReleaseFeed(yml, RELEASE_FEED_URL ?? "")).toBe(true);
  expect(parseReleaseFeed(yml, "https://github.com/Utopia-USS/cashu/releases/download/")).toBe(
    false,
  );
});

it("verifies the same designated requirement the update authority checks", () => {
  expect(APP_ID).toBe("io.utopiasoft.cashu");
  expect(developerIdRequirement("29W838VKU4")).toBe(authorityRequirement("29W838VKU4"));
  expect(() => developerIdRequirement("$(bad)")).toThrow("invalid_team_id");
});

it("refuses an ambiguous, malformed or non-canonical policy source", () => {
  const unset = fakeRoot(
    "export const RELEASE_TEAM_ID: string | null = null;\nexport const RELEASE_FEED_URL: string | null = null;\n",
  );
  expect(readReleasePolicy(unset)).toEqual({ teamId: null, feedUrl: null });
  expect(() => appUpdateYml({ teamId: null, feedUrl: null })).toThrow("not pinned");
  const twice = fakeRoot(
    'export const RELEASE_TEAM_ID: string | null = "ABCDE12345";\nexport const RELEASE_TEAM_ID: string | null = "ZZZZZ12345";\nexport const RELEASE_FEED_URL: string | null = null;\n',
  );
  expect(() => readReleasePolicy(twice)).toThrow("expected one RELEASE_TEAM_ID");
  const http = fakeRoot(
    'export const RELEASE_TEAM_ID: string | null = "ABCDE12345";\nexport const RELEASE_FEED_URL: string | null = "http://example.test/";\n',
  );
  expect(() => readReleasePolicy(http)).toThrow("canonical https");
  const badTeam = fakeRoot(
    'export const RELEASE_TEAM_ID: string | null = "abc";\nexport const RELEASE_FEED_URL: string | null = null;\n',
  );
  expect(() => readReleasePolicy(badTeam)).toThrow("not a team ID");
});

it("takes the team from an explicit Developer ID identity and names artifacts per arch", () => {
  expect(
    developerIdTeam(
      "Developer ID Application: Utopia Ultimate Software Solutions Sp. z o.o. (29W838VKU4)",
    ),
  ).toBe("29W838VKU4");
  expect(() => developerIdTeam("Apple Development: Someone (ABCDE12345)")).toThrow("--sign");
  expect(() => developerIdTeam("-")).toThrow("--sign");
  expect(artifactName("0.5.0", "arm64", "zip")).toBe("cashU-0.5.0-mac-arm64.zip");
  expect(artifactName("0.5.0", "x64", "dmg")).toBe("cashU-0.5.0-mac-x64.dmg");
  expect(artifactName("0.5.0", "x64", "zip")).not.toContain("arm64");
  expect(() => artifactName("0.5.0", "universal", "zip")).toThrow();
});

const testMarker = {
  schema: 1,
  kind: "cashu-test-build",
  feedUrl: "http://127.0.0.1:47123/",
  installRoot: "/tmp/w3a/install",
  dataDir: "/tmp/w3a/data",
  workspacesDir: "/tmp/w3a/workspaces",
};

it("seals a test build marker the app parses identically, with its local feed", () => {
  const text = testBuildJson(testMarker);
  expect(parseTestBuild(text)).toEqual(testMarker);
  expect(parseTestBuildMarker(text)).toEqual(testMarker);
  const yml = testAppUpdateYml(testMarker);
  expect(parseTestBuildFeed(yml, testMarker.feedUrl)).toBe(true);
  // A test feed is never the release feed, and the release yml never passes the test parser.
  expect(parseReleaseFeed(yml, testMarker.feedUrl)).toBe(false);
  expect(parseTestBuildFeed(appUpdateYml(readReleasePolicy(root)), RELEASE_FEED_URL)).toBe(false);
});

it("rejects the same malformed markers as the app", () => {
  for (const bad of [
    { ...testMarker, extra: 1 },
    { ...testMarker, feedUrl: "http://localhost:47123/" },
    { ...testMarker, feedUrl: RELEASE_FEED_URL },
    { ...testMarker, installRoot: "/Applications/cashU-test" },
    { ...testMarker, dataDir: "/Users/x/Library/Application Support/cashU" },
    { ...testMarker, dataDir: "/Users/x/Documents/cashU" },
    { ...testMarker, dataDir: "data" },
  ]) {
    const text = JSON.stringify(bad);
    expect(() => parseTestBuild(text)).toThrow();
    expect(() => parseTestBuildMarker(text)).toThrow();
  }
});

it("refuses to release a bundle that carries the test-build marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "cashu-release-policy-app-"));
  temps.push(dir);
  const app = join(dir, "cashU.app");
  mkdirSync(join(app, "Contents/Resources"), { recursive: true });
  expect(() => assertNoTestBuild(app)).not.toThrow();
  expect(readTestBuild(app)).toBeNull();
  writeFileSync(join(app, TEST_BUILD_MARKER), testBuildJson(testMarker));
  expect(readTestBuild(app)).toEqual(testMarker);
  expect(() => assertNoTestBuild(app)).toThrow(/TEST BUILD.*can never be released/);
  // Even an invalid or empty marker is refused for a release.
  writeFileSync(join(app, TEST_BUILD_MARKER), "");
  expect(() => assertNoTestBuild(app)).toThrow(/TEST BUILD/);
});
