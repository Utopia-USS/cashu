import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyDataAdmission, legacySourceRoots } from "@cashu/node-host/admission";
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

test("an empty synthetic data dir only reports no legacy sentinel", () => {
  expect(legacyDataAdmission(fixture())).toBe("no_legacy_sentinel");
});

test.each(["cashu.db", "finanse.db"])("%s blocks native Create without opening it", (name) => {
  const dir = fixture();
  writeFileSync(join(dir, name), "synthetic", { mode: 0o600 });
  expect(legacyDataAdmission(dir)).toBe("migration_required");
});

test("orphan journal and redirected database refuse rather than look empty", () => {
  const dir = fixture();
  writeFileSync(join(dir, "cashu.db-wal"), "synthetic", { mode: 0o600 });
  expect(legacyDataAdmission(dir)).toBe("refused");
  const other = fixture();
  writeFileSync(join(other, "source"), "synthetic", { mode: 0o600 });
  symlinkSync(join(other, "source"), join(other, "cashu.db"));
  expect(legacyDataAdmission(other)).toBe("refused");
});

test("two Python database names are ambiguous", () => {
  const dir = fixture();
  writeFileSync(join(dir, "cashu.db"), "synthetic", { mode: 0o600 });
  writeFileSync(join(dir, "finanse.db"), "synthetic", { mode: 0o600 });
  expect(legacyDataAdmission(dir)).toBe("refused");
});

test("pre-rename platform data and old checkout data block an empty selected dir", () => {
  const home = fixture();
  const project = fixture();
  const selected = fixture();
  const legacy = join(home, "legacy");
  const roots = legacySourceRoots(
    selected,
    project,
    home,
    { CASHU_LEGACY_DATA_DIR: legacy },
    "darwin",
  );
  expect(legacyDataAdmission(roots)).toBe("no_legacy_sentinel");
  mkdirSync(legacy);
  writeFileSync(join(legacy, "finanse.db"), "synthetic");
  expect(legacyDataAdmission(roots)).toBe("migration_required");
  rmSync(legacy, { recursive: true });
  mkdirSync(join(project, "data"));
  writeFileSync(join(project, "data", "finanse.db"), "synthetic");
  expect(legacyDataAdmission(roots)).toBe("migration_required");
});

test("explicit portable data ignores automatic home and checkout roots", () => {
  const home = fixture();
  const project = fixture();
  const selected = fixture();
  mkdirSync(join(project, "data"));
  writeFileSync(join(project, "data", "finanse.db"), "synthetic");
  const roots = legacySourceRoots(selected, project, home, {}, "darwin", true);
  expect(roots).toEqual([selected]);
  expect(legacyDataAdmission(roots)).toBe("no_legacy_sentinel");
});
