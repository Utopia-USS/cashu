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
  // No file yet: the automatic daily check is on (notify only).
  expect(first.read()).toEqual({ auto: true, skippedVersion: null, dismissedVersion: null });
  first.write({ auto: false, skippedVersion: "1.2.3", dismissedVersion: null });
  expect(updatePreferences(root).read()).toEqual({
    auto: false,
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

it("refuses a stored record with a missing, extra or malformed field", () => {
  const root = mkdtempSync(join(tmpdir(), "cashu-update-"));
  roots.push(root);
  const store = updatePreferences(root);
  const file = join(root, "update-preferences.json");
  const valid = { auto: true, skippedVersion: null, dismissedVersion: "1.0.0" };
  for (const record of [
    { auto: true, skippedVersion: null },
    { ...valid, extra: 1 },
    { ...valid, auto: "yes" },
    { ...valid, skippedVersion: "latest" },
    [valid],
    null,
  ]) {
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    expect(() => store.read()).toThrow("invalid_update_preferences");
  }
  writeFileSync(file, JSON.stringify(valid), { mode: 0o600 });
  expect(store.read()).toEqual(valid);
});
