import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTestBuildMarker, readTestBuildMarker, TEST_BUILD_MARKER } from "./testBuild.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const marker = {
  schema: 1,
  kind: "cashu-test-build",
  feedUrl: "http://127.0.0.1:47123/",
  installRoot: "/tmp/cashu-lab/install",
  dataDir: "/tmp/cashu-lab/data",
  workspacesDir: "/tmp/cashu-lab/workspaces",
};
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A synthetic bundle whose manifest lists every resource (as package-macos.mjs writes it). */
function bundle(extra: Record<string, string> = {}, unlisted: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cashu-test-build-"));
  roots.push(root);
  const app = join(root, "cashU.app");
  const resources: Record<string, string> = {
    "Contents/Resources/host.mjs": "host",
    "Contents/Resources/shim.mjs": "shim",
    "Contents/Resources/native/CashUNotifications.node": "addon",
    "Contents/Resources/native/CashUHostService.node": "service",
    "Contents/Resources/notify-catalog-v1.json": "{}",
    "Contents/Resources/skills/workspace-setup/SKILL.md": "skill",
    "Contents/Resources/connectors/README.md": "catalog",
    "Contents/Resources/renderer/index.html": "<html></html>",
    "Contents/Resources/app.asar": "asar",
    "Contents/MacOS/cashu-host-agent": "agent",
    "Contents/Library/LaunchAgents/io.utopiasoft.cashu.host.plist": "plist",
    ...extra,
  };
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries({ ...resources, ...unlisted })) {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), content);
  }
  for (const [path, content] of Object.entries(resources))
    files[path] = createHash("sha256").update(content).digest("hex");
  writeFileSync(join(app, "Contents/Info.plist"), "info");
  writeFileSync(join(app, "Contents/MacOS/cashU"), "binary");
  writeFileSync(
    join(app, "Contents/Resources/bundle-manifest.json"),
    JSON.stringify({ schema: 1, files }),
  );
  return app;
}

describe("test-build marker", () => {
  it("parses only the exact sealed shape", () => {
    expect(parseTestBuildMarker(text(marker))).toEqual(marker);
    const bad: unknown[] = [
      { ...marker, extra: true },
      { ...marker, schema: 2 },
      { ...marker, kind: "release" },
      { ...marker, feedUrl: "https://127.0.0.1:47123/" },
      { ...marker, feedUrl: "http://localhost:47123/" },
      { ...marker, feedUrl: "http://127.0.0.1/" },
      { ...marker, feedUrl: "http://127.0.0.1:99999/" },
      { ...marker, feedUrl: "http://127.0.0.1:47123/feed/" },
      { ...marker, installRoot: "/Applications" },
      { ...marker, installRoot: "/Applications/test" },
      { ...marker, installRoot: "relative/install" },
      { ...marker, installRoot: "/tmp/x/../install" },
      { ...marker, installRoot: "/" },
      { ...marker, dataDir: "/Users/someone/Library/Application Support/cashU" },
      { ...marker, dataDir: "/Users/someone/Library/Application Support/cashU/nested" },
      { ...marker, dataDir: "/Users/someone/Documents/cashU" },
      { ...marker, dataDir: marker.installRoot },
      { ...marker, workspacesDir: `${marker.dataDir}/workspaces` },
      { ...marker, workspacesDir: "/Users/someone/Documents/cashU" },
      {
        schema: 1,
        kind: "cashu-test-build",
        feedUrl: marker.feedUrl,
        installRoot: "/tmp/a",
        dataDir: "/tmp/b",
      },
      [marker],
      null,
    ];
    for (const value of bad) expect(() => parseTestBuildMarker(text(value))).toThrow();
    expect(() => parseTestBuildMarker("{not json")).toThrow();
  });

  it("refuses the real dirs of every flavor in any letter case (macOS disks are case-insensitive)", () => {
    const real = [
      "/applications/test",
      "/APPLICATIONS",
      "/Users/someone/library/application support/cashU",
      "/Users/someone/LIBRARY/Application Support/CASHU/nested",
      "/Users/someone/Library/application support/cashu staging",
      "/Users/someone/library/Application Support/cashU Staging",
      "/Users/someone/documents/cashU",
      "/Users/someone/DOCUMENTS/CASHU STAGING",
    ];
    for (const dir of real) {
      expect(() => parseTestBuildMarker(text({ ...marker, dataDir: dir }))).toThrow(
        "test_build_marker_invalid",
      );
      expect(() => parseTestBuildMarker(text({ ...marker, workspacesDir: dir }))).toThrow(
        "test_build_marker_invalid",
      );
    }
    // Trees that differ only in case are one tree on such a disk.
    expect(() =>
      parseTestBuildMarker(text({ ...marker, workspacesDir: `${marker.dataDir.toUpperCase()}/w` })),
    ).toThrow("test_build_marker_invalid");
    // A synthetic dir that only resembles them stays valid.
    expect(
      parseTestBuildMarker(
        text({ ...marker, dataDir: "/Users/someone/library/application support/cashU-test" }),
      ).dataDir,
    ).toBe("/Users/someone/library/application support/cashU-test");
  });

  it("is absent from a bundle without the marker (every release)", () => {
    expect(readTestBuildMarker(bundle())).toBeNull();
  });

  it("is honored only when the manifest lists and hashes the marker", () => {
    expect(readTestBuildMarker(bundle({ [TEST_BUILD_MARKER]: text(marker) }))).toEqual(marker);
    // Dropped into a sealed bundle afterwards: the manifest does not list it.
    expect(() => readTestBuildMarker(bundle({}, { [TEST_BUILD_MARKER]: text(marker) }))).toThrow(
      "test_build_marker_unverified",
    );
    // Listed, then edited: the hash differs.
    const app = bundle({ [TEST_BUILD_MARKER]: text(marker) });
    writeFileSync(
      join(app, TEST_BUILD_MARKER),
      text({ ...marker, feedUrl: "http://127.0.0.1:40000/" }),
    );
    expect(() => readTestBuildMarker(app)).toThrow("test_build_marker_unverified");
    // Listed and hashed, but not a valid marker.
    expect(() =>
      readTestBuildMarker(bundle({ [TEST_BUILD_MARKER]: text({ ...marker, schema: 2 }) })),
    ).toThrow("test_build_marker_invalid");
  });
});
