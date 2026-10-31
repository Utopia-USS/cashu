import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadState, rememberedPort, rememberPort, saveState } from "./state.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cashu-desktop-state-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("desktop.json", () => {
  it("is written atomically and owner-only", () => {
    const path = join(dir, "data", "desktop.json");
    saveState(path, { port: 51234 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "data")).mode & 0o777).toBe(0o700);
    expect(loadState(path)).toEqual({ port: 51234 });
  });

  it("ignores unreadable or foreign content", () => {
    const path = join(dir, "desktop.json");
    expect(loadState(path)).toEqual({});
    writeFileSync(path, "not json");
    expect(loadState(path)).toEqual({});
    writeFileSync(path, "[1, 2]");
    expect(loadState(path)).toEqual({});
  });

  it("remembers only a usable port", () => {
    expect(rememberedPort({ port: 8500 })).toBe(8500);
    for (const port of [80, 70000, "8500", 8500.5, null, undefined]) {
      expect(rememberedPort({ port })).toBeNull();
    }
  });

  it("keeps other keys and survives a failing disk", () => {
    const path = join(dir, "desktop.json");
    saveState(path, { other: 1 });
    rememberPort(path, 51000);
    expect(loadState(path)).toEqual({ other: 1, port: 51000 });
    expect(() => rememberPort(join(path, "not-a-dir", "x.json"), 51001)).not.toThrow();
  });
});
