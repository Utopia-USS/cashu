import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanup, tempDir } from "../testing/harness.js";
import { emptyWorkerState } from "./contracts.js";
import { privateWorkerState } from "./state.js";

afterEach(cleanup);
it("atomically persists owner-only bookkeeping and refuses permissive, corrupt and oversized input", async () => {
  const root = tempDir(),
    directory = join(root, "worker");
  mkdirSync(directory, { mode: 0o700 });
  let current = true;
  const port = privateWorkerState(directory, () => current),
    path = join(directory, "native-state.json");
  expect(await port.load()).toEqual(emptyWorkerState());
  await port.save(emptyWorkerState());
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(directory)).toEqual(["native-state.json"]);
  chmodSync(path, 0o644);
  await expect(port.load()).rejects.toThrow("worker_state_unavailable");
  chmodSync(path, 0o600);
  writeFileSync(path, "{", { mode: 0o600 });
  await expect(port.load()).rejects.toThrow("worker_state_unavailable");
  writeFileSync(path, Buffer.alloc(4 * 1024 * 1024 + 1), { mode: 0o600 });
  await expect(port.load()).rejects.toThrow("worker_state_unavailable");
  current = false;
  await expect(port.save(emptyWorkerState())).rejects.toThrow("worker_state_unavailable");
});
it("refuses a symlink state target and a replaced private root without changing their destination", async () => {
  const root = tempDir(),
    directory = join(root, "worker"),
    outside = join(root, "outside");
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  let current = true;
  const port = privateWorkerState(directory, () => current),
    destination = join(outside, "ledger.json");
  writeFileSync(destination, "synthetic untouched", { mode: 0o600 });
  symlinkSync(destination, join(directory, "native-state.json"));
  await expect(port.load()).rejects.toThrow("worker_state_unavailable");
  await expect(port.save(emptyWorkerState())).rejects.toThrow("worker_state_unavailable");
  expect(readFileSync(destination, "utf8")).toBe("synthetic untouched");
  renameSync(directory, join(root, "original"));
  symlinkSync(outside, directory);
  await expect(port.save(emptyWorkerState())).rejects.toThrow("worker_state_unavailable");
  expect(readdirSync(outside)).toEqual(["ledger.json"]);
  current = false;
});
it("cleans its temporary file when authority is revoked before rename", async () => {
  const directory = tempDir();
  let calls = 0;
  const port = privateWorkerState(directory, () => ++calls < 3);
  await expect(port.save(emptyWorkerState())).rejects.toThrow("worker_state_unavailable");
  expect(readdirSync(directory)).toEqual([]);
});
