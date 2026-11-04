import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STRATEGY_MD, STRATEGY_YAML } from "@cashu/store/investments/services";
import { afterEach, expect, it } from "vitest";
import { workerStrategyFiles } from "./strategyFiles.js";

const roots: string[] = [];
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-worker-files-")));
  chmodSync(root, 0o700);
  roots.push(root);
  const directory = join(root, "native-vault");
  mkdirSync(directory, { mode: 0o700 });
  let current = true;
  const files = workerStrategyFiles({
    vault: "synthetic-vault",
    privateRoot: root,
    directory,
    isCurrent: () => current,
  });
  return {
    root,
    directory,
    files,
    revoke: () => {
      current = false;
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("uses checked reads and refuses worker publication", async () => {
  const { directory, files } = fixture();
  expect(await files.read(STRATEGY_YAML)).toBeNull();
  expect(await files.exists(STRATEGY_MD)).toBe(false);
  await expect(files.write(STRATEGY_YAML, "synthetic: true\n")).rejects.toThrow(
    "worker_strategy_write_unavailable",
  );
  writeFileSync(join(directory, STRATEGY_YAML), "synthetic: true\n", { mode: 0o600 });
  expect(await files.read(STRATEGY_YAML)).toBe("synthetic: true\n");
  expect(await files.exists(STRATEGY_YAML)).toBe(true);
});

it("reports revoked or swapped file authority without returning stale contents", async () => {
  const { directory, files, revoke } = fixture();
  writeFileSync(join(directory, STRATEGY_YAML), "synthetic", { mode: 0o600 });
  revoke();
  await expect(files.read(STRATEGY_YAML)).rejects.toThrow();
  await expect(files.write(STRATEGY_MD, "synthetic")).rejects.toThrow();
});

it("refuses a symlinked strategy target", async () => {
  const { root, directory, files } = fixture();
  const other = join(root, "other");
  writeFileSync(other, "synthetic", { mode: 0o600 });
  symlinkSync(other, join(directory, STRATEGY_YAML));
  await expect(files.read(STRATEGY_YAML)).rejects.toThrow();
});
