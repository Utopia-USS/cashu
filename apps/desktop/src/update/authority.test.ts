import { expect, it } from "vitest";
import { developerIdRequirement, parseReleaseFeed } from "./authority.js";

const url = "https://updates.example.test/cashu-next/";
it("requires one exact, credential-free generic feed URL", () => {
  expect(
    parseReleaseFeed(`provider: generic\nurl: ${url}\nupdaterCacheDirName: cashu-next\n`, url),
  ).toBe(true);
  expect(
    parseReleaseFeed(`provider: generic\nurl: ${url}\nurl: https://evil.example.test/\n`, url),
  ).toBe(false);
  expect(parseReleaseFeed(`provider: generic\nprovider: github\nurl: ${url}\n`, url)).toBe(false);
  expect(
    parseReleaseFeed(
      `provider: generic\nurl: https://name:secret@updates.example.test/cashu-next/\n`,
      url,
    ),
  ).toBe(false);
  expect(
    parseReleaseFeed(`provider: generic\nurl: ${url}\nheaders: {Authorization: secret}\n`, url),
  ).toBe(false);
});

it("pins the Apple Developer ID requirement to the app ID and release team", () => {
  const requirement = developerIdRequirement("ABCDE12345");
  expect(requirement).toContain('identifier "io.utopiasoft.cashu.next"');
  expect(requirement).toContain("anchor apple generic");
  expect(requirement).toContain("1.2.840.113635.100.6.1.13");
  expect(requirement).toContain('certificate leaf[subject.OU] = "ABCDE12345"');
  expect(() => developerIdRequirement("$(bad)")).toThrow("invalid_team_id");
});
