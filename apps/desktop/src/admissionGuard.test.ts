import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacySourceRoots, oldAppDataRoots } from "@cashu/node-host/admission";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cashu-admission-test-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an empty synthetic data dir holds no old app data", () => {
  expect(oldAppDataRoots([fixture()])).toBe(0);
});

test.each(["cashu.db", "finanse.db", "cashu.db-wal"])(
  "%s counts as old app data without being opened",
  (name) => {
    const dir = fixture();
    writeFileSync(join(dir, name), "synthetic", { mode: 0o600 });
    expect(oldAppDataRoots([dir])).toBe(1);
  },
);

test("a redirected database still counts as there", () => {
  const dir = fixture();
  symlinkSync(join(dir, "missing"), join(dir, "cashu.db"));
  expect(oldAppDataRoots([dir])).toBe(1);
});

test("pre-rename platform data and old checkout data are found beside an empty selected dir", () => {
  const home = fixture();
  const project = fixture();
  const selected = fixture();
  const legacy = join(home, "legacy");
  const found = legacySourceRoots(
    selected,
    project,
    home,
    { CASHU_LEGACY_DATA_DIR: legacy },
    "darwin",
  );
  expect(oldAppDataRoots(found)).toBe(0);
  mkdirSync(legacy);
  writeFileSync(join(legacy, "finanse.db"), "synthetic");
  expect(oldAppDataRoots(found)).toBe(1);
  mkdirSync(join(project, "data"));
  writeFileSync(join(project, "data", "finanse.db"), "synthetic");
  expect(oldAppDataRoots(found)).toBe(2);
});

test("explicit portable data ignores automatic home and checkout roots", () => {
  const home = fixture();
  const project = fixture();
  const selected = fixture();
  mkdirSync(join(project, "data"));
  writeFileSync(join(project, "data", "finanse.db"), "synthetic");
  const found = legacySourceRoots(selected, project, home, {}, "darwin", true);
  expect(found).toEqual([selected]);
  expect(oldAppDataRoots(found)).toBe(0);
});
