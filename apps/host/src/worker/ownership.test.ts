import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OpenVault } from "../stores.js";
import { admittedWorkerOwnership } from "./ownership.js";

const roots: string[] = [];
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "cashu-worker-owner-"));
  chmodSync(dataDir, 0o700);
  roots.push(dataDir);
  let current = true;
  let nativeOnly = true;
  const vault = {
    id: "a".repeat(32),
    mode: "native",
    native: { canRunSideEffects: () => current },
  } as unknown as OpenVault;
  const input = {
    dataDir,
    vaults: [vault],
    assertAdmission() {
      if (!nativeOnly || existsSync(join(dataDir, "cashu.db"))) throw new Error("legacy present");
    },
  };
  return {
    dataDir,
    vault,
    input,
    revoke: () => {
      current = false;
    },
    addLegacy: () => {
      writeFileSync(join(dataDir, "cashu.db"), "synthetic");
    },
    revokeNativeOnly: () => {
      nativeOnly = false;
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("persists one exact native daily owner and rechecks admission", () => {
  const f = fixture();
  const first = admittedWorkerOwnership(f.input);
  expect(first.isExclusive("investments.daily", f.vault)).toBe(true);
  expect(first.isExclusive("budget.sync", f.vault)).toBe(false);
  expect(admittedWorkerOwnership(f.input).isExclusive("investments.daily", f.vault)).toBe(true);
  f.revoke();
  expect(first.isExclusive("investments.daily", f.vault)).toBe(false);
});

it("refuses a new Python database or lost native-only proof", () => {
  const f = fixture();
  const owner = admittedWorkerOwnership(f.input);
  f.addLegacy();
  expect(owner.isExclusive("investments.daily", f.vault)).toBe(false);
  expect(() => admittedWorkerOwnership(f.input)).toThrow();
  rmSync(join(f.dataDir, "cashu.db"));
  f.revokeNativeOnly();
  expect(owner.isExclusive("investments.daily", f.vault)).toBe(false);
});

it("refuses malformed or replaced private ownership without resetting it", () => {
  const f = fixture();
  mkdirSync(join(f.dataDir, "worker"), { mode: 0o700 });
  writeFileSync(join(f.dataDir, "worker", "ownership.json"), "{broken", { mode: 0o600 });
  expect(() => admittedWorkerOwnership(f.input)).toThrow("worker_ownership_unavailable");
  const duplicate = {
    version: 1,
    generation: 1,
    jobs: { "investments.daily": { owner: "native", vaults: [f.vault.id, f.vault.id] } },
  };
  writeFileSync(join(f.dataDir, "worker", "ownership.json"), JSON.stringify(duplicate));
  expect(() => admittedWorkerOwnership(f.input)).toThrow("worker_ownership_unavailable");
  expect(JSON.parse(readFileSync(join(f.dataDir, "worker", "ownership.json"), "utf8"))).toEqual(
    duplicate,
  );
});

it("extends native daily ownership when another admitted vault is added", () => {
  const f = fixture();
  const first = admittedWorkerOwnership(f.input);
  const additional = {
    id: "b".repeat(32),
    mode: "native",
    native: { canRunSideEffects: () => true },
  } as unknown as OpenVault;
  const second = admittedWorkerOwnership({ ...f.input, vaults: [f.vault, additional] });
  expect(first.isExclusive("investments.daily", f.vault)).toBe(true);
  expect(second.isExclusive("investments.daily", additional)).toBe(true);
  const record = JSON.parse(readFileSync(join(f.dataDir, "worker", "ownership.json"), "utf8"));
  expect(record.generation).toBe(2);
  expect(record.jobs["investments.daily"].vaults).toEqual([f.vault.id, additional.id]);
});

it("leaves an ineligible vault out of the native job switch", () => {
  const f = fixture();
  const owner = admittedWorkerOwnership({ ...f.input, vaults: [] });
  expect(owner.isExclusive("investments.daily", f.vault)).toBe(false);
  expect(existsSync(join(f.dataDir, "worker", "ownership.json"))).toBe(false);
});
