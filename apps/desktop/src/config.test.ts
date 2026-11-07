import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyDataAdmission, legacySourceRoots } from "@cashu/node-host/admission";
import { FLAVORS } from "@cashu/node-host/flavor";
import { describe, expect, it } from "vitest";
import {
  checkDataDir,
  defaultDataDir,
  realResolve,
  resolveDataDir,
  TEST_BUILD_TITLE,
  testBuildDataDir,
} from "./config.js";

describe("data dir", () => {
  it("uses CASHU_DATA_DIR when set (and expands ~)", () => {
    expect(
      resolveDataDir({ CASHU_DATA_DIR: "/cashu-nonexistent/demo" }, "darwin", "/Users/x"),
    ).toEqual({
      dir: "/cashu-nonexistent/demo",
      explicit: true,
    });
    expect(resolveDataDir({ CASHU_DATA_DIR: "~/lab/demo" }, "darwin", "/Users/x").dir).toBe(
      "/Users/x/lab/demo",
    );
  });

  it("resolves symlinks through existing path components", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "cashu-desktop-config-")));
    try {
      mkdirSync(join(base, "real"));
      symlinkSync(join(base, "real"), join(base, "link"));
      expect(realResolve(join(base, "link", "data", "deeper"))).toBe(
        join(base, "real", "data", "deeper"),
      );
      expect(resolveDataDir({ CASHU_DATA_DIR: join(base, "link", "d") }).dir).toBe(
        join(base, "real", "d"),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("falls back to the platform default like core/paths.py", () => {
    expect(defaultDataDir("darwin", "/Users/x", {})).toBe(
      "/Users/x/Library/Application Support/cashU",
    );
    expect(defaultDataDir("linux", "/home/x", {})).toBe("/home/x/.local/share/cashu");
    expect(defaultDataDir("win32", "C:/Users/x", { APPDATA: "C:/Roaming" })).toBe(
      "C:/Roaming/cashU",
    );
    expect(resolveDataDir({}, "darwin", "/Users/x").explicit).toBe(false);
  });

  it("names the staging app's default data dir after its flavor", () => {
    expect(defaultDataDir("darwin", "/Users/x", {}, FLAVORS.staging)).toBe(
      "/Users/x/Library/Application Support/cashU Staging",
    );
    expect(defaultDataDir("linux", "/home/x", {}, FLAVORS.staging)).toBe(
      "/home/x/.local/share/cashu-staging",
    );
    expect(resolveDataDir({}, "darwin", "/Users/x", FLAVORS.staging).dir).toBe(
      "/Users/x/Library/Application Support/cashU Staging",
    );
  });

  it("refuses a development run on the default data dir", () => {
    const choice = resolveDataDir({}, "darwin", "/Users/x");
    expect(checkDataDir({ choice, isPackaged: false })).toMatch(/CASHU_DATA_DIR/);
    expect(checkDataDir({ choice, isPackaged: true })).toBeNull();
  });

  it("pins the data dir into the allowed root", () => {
    const inside = { dir: "/Users/x/cashu-lab/desktop-demo", explicit: true };
    const outside = { dir: "/Users/x/Library/Application Support/cashU", explicit: true };
    const sibling = { dir: "/Users/x/cashu-lab-other/data", explicit: true };
    const root = "/Users/x/cashu-lab";
    expect(checkDataDir({ choice: inside, isPackaged: false, allowedRoot: root })).toBeNull();
    expect(checkDataDir({ choice: outside, isPackaged: false, allowedRoot: root })).toMatch(
      /outside/,
    );
    expect(checkDataDir({ choice: sibling, isPackaged: false, allowedRoot: root })).toMatch(
      /outside/,
    );
  });
});

describe("test-build data dir", () => {
  it("never changes a release's choice (no marker)", () => {
    const choice = { dir: "/anything", explicit: false };
    expect(testBuildDataDir(choice, null)).toEqual({ choice });
  });

  it("runs a test build on its marker's data dir, also without CASHU_DATA_DIR", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-test-build-dir-")));
    try {
      const data = join(root, "data");
      const marker = { choice: { dir: data, explicit: true } };
      expect(testBuildDataDir({ dir: data, explicit: true }, data)).toEqual(marker);
      // The updater relaunches without any environment: the default dir is replaced, never used.
      const fallback = resolveDataDir({}, "darwin", "/Users/someone");
      expect(fallback.dir).toBe("/Users/someone/Library/Application Support/cashU");
      expect(testBuildDataDir(fallback, data)).toEqual(marker);
      const other = testBuildDataDir({ dir: join(root, "other"), explicit: true }, data);
      expect(other).toMatchObject({ error: expect.stringMatching(/TEST BUILD.*CASHU_DATA_DIR/) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(TEST_BUILD_TITLE).toBe("cashU - TEST BUILD");
  });

  it("finds Python data in a test build's marker data dir, and only there", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-test-build-python-")));
    try {
      const data = join(root, "data");
      mkdirSync(data);
      writeFileSync(join(data, "cashu.db"), "synthetic");
      // A relaunch without environment: main's choice is the marker dir, explicit, so the admission
      // roots are that dir alone (never the real default or the Python app's other roots).
      const fallback = resolveDataDir({}, "darwin", join(root, "home"));
      const chosen = testBuildDataDir(fallback, data);
      if (!("choice" in chosen)) throw new Error("expected a choice");
      const roots = legacySourceRoots(
        chosen.choice.dir,
        join(root, "checkout"),
        join(root, "home"),
        {},
        "darwin",
        chosen.choice.explicit,
      );
      expect(roots).toEqual([data]);
      expect(legacyDataAdmission(roots)).toBe("migration_required");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
