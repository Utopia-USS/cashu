import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDataDir, defaultDataDir, realResolve, resolveDataDir } from "./config.js";

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

  it("resolves symlinks like Path.resolve() in the sidecar (macOS /var -> /private/var)", () => {
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
