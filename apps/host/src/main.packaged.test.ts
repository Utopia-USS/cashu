import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { main, requiresPackagedIdentity } from "./main.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("refuses a caller bundle flag from the source host", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cashu-host-identity-"));
  roots.push(dataDir);
  const errors: string[] = [];
  const io = {
    env: { CASHU_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: "1" },
    build: "desktop-1.0.0",
    stdout: () => undefined,
    stderr: (line: string) => {
      errors.push(line);
    },
    onSignal: () => undefined,
  };
  expect(
    await main(["run", "--data-dir", dataDir, "--bundle", join(dataDir, "fake.mjs")], io),
  ).toBe(64);
  expect(errors).toHaveLength(1);
});

it("keeps Electron-as-Node TypeScript source in the development path", () => {
  expect(requiresPackagedIdentity("/checkout")).toBe(false);
  expect(requiresPackagedIdentity(undefined)).toBe(true);
});
