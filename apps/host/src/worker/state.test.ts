import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { linkDir, linkFile } from "@cashu/node-host/testing/links";
import { afterEach, expect, it } from "vitest";
import { cleanup, tempDir } from "../testing/harness.js";
import { emptyWorkerState } from "./contracts.js";
import { privateWorkerState } from "./state.js";

afterEach(cleanup);
it("atomically persists bookkeeping and refuses corrupt and oversized input", async () => {
  const root = tempDir(),
    directory = join(root, "worker");
  mkdirSync(directory, { mode: 0o700 });
  let current = true;
  const port = privateWorkerState(directory, () => current),
    path = join(directory, "native-state.json");
  expect(await port.load()).toEqual(emptyWorkerState());
  await port.save(emptyWorkerState());
  expect(readdirSync(directory)).toEqual(["native-state.json"]);
  writeFileSync(path, "{", { mode: 0o600 });
  await expect(port.load()).rejects.toThrow("worker_state_unavailable");
  writeFileSync(path, Buffer.alloc(4 * 1024 * 1024 + 1), { mode: 0o600 });
  await expect(port.load()).rejects.toThrow("worker_state_unavailable");
  current = false;
  await expect(port.save(emptyWorkerState())).rejects.toThrow("worker_state_unavailable");
});
// POSIX permission bits: Windows reports a synthetic mode and ignores chmod.
it.skipIf(process.platform === "win32")(
  "persists owner-only and refuses a permissive file",
  async () => {
    const directory = join(tempDir(), "worker");
    mkdirSync(directory, { mode: 0o700 });
    const port = privateWorkerState(directory, () => true),
      path = join(directory, "native-state.json");
    await port.save(emptyWorkerState());
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    await expect(port.load()).rejects.toThrow("worker_state_unavailable");
  },
);
it("reads Windows' synthetic modes as private and still refuses a hard link", async () => {
  const directory = join(tempDir(), "worker");
  mkdirSync(directory, { mode: 0o700 });
  const port = privateWorkerState(directory, () => true, "win32"),
    path = join(directory, "native-state.json");
  await port.save(emptyWorkerState());
  // Windows reports a writable file as 0666 and a directory as 0777; neither is a refusal there.
  chmodSync(path, 0o644);
  chmodSync(directory, 0o755);
  expect(await port.load()).toEqual(emptyWorkerState());
  await port.save(emptyWorkerState());
  linkSync(path, join(directory, "second-name"));
  await expect(port.load()).rejects.toThrow("worker_state_unavailable");
});
// The state link is a file symlink (on a Windows runner without the privilege to create it the test
// skips itself); the replaced root is a junction on Windows.
it("refuses a symlink state target and a replaced private root without changing their destination", async ({
  skip,
}) => {
  const root = tempDir(),
    directory = join(root, "worker"),
    outside = join(root, "outside");
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  let current = true;
  const port = privateWorkerState(directory, () => current),
    destination = join(outside, "ledger.json");
  writeFileSync(destination, "synthetic untouched", { mode: 0o600 });
  linkFile(destination, join(directory, "native-state.json"), skip);
  await expect(port.load()).rejects.toThrow("worker_state_unavailable");
  await expect(port.save(emptyWorkerState())).rejects.toThrow("worker_state_unavailable");
  expect(readFileSync(destination, "utf8")).toBe("synthetic untouched");
  renameSync(directory, join(root, "original"));
  linkDir(outside, directory);
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
