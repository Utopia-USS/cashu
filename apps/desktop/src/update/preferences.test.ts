import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { updatePreferences } from "./preferences.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("persists only bounded update choices across controller restarts", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-update-"));
  roots.push(root);
  const first = updatePreferences(root);
  expect(first.read()).toEqual({ auto: false, skippedVersion: null, dismissedVersion: null });
  first.write({ auto: true, skippedVersion: "1.2.3", dismissedVersion: null });
  expect(updatePreferences(root).read()).toEqual({
    auto: true,
    skippedVersion: "1.2.3",
    dismissedVersion: null,
  });
  writeFileSync(join(root, "update-preferences.json"), "x".repeat(1025));
  expect(() => first.read()).toThrow("update_preferences_not_private");
});

it("refuses a preference symlink and a nonprivate directory", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-update-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(join(root, "target.json"), "{}");
  symlinkSync(join(root, "target.json"), join(data, "update-preferences.json"));
  expect(() => updatePreferences(data).read()).toThrow();
});
