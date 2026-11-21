import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ensurePrivateDir } from "./state.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cashu-desktop-state-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("creates the desktop private directory as owner-only", () => {
  const path = join(dir, "data", "desktop");
  expect(ensurePrivateDir(path)).toBe(path);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o700);
  expect(ensurePrivateDir(path)).toBe(path);
});
