import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverStrategies, readStrategyFile } from "@cashu/store/investments/services";
import { afterEach, expect, it } from "vitest";
import { nativeStrategyCliFiles, nativeStrategyDocuments } from "./nativeStrategyDocuments.js";

const roots: string[] = [];
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-native-strategy-")));
  chmodSync(root, 0o700);
  roots.push(root);
  const directory = join(root, "vault");
  mkdirSync(directory, { mode: 0o700 });
  let active = true;
  const authority = {
    vault: "synthetic-vault",
    privateRoot: root,
    directory,
    isCurrent: () => active,
  };
  return {
    root,
    directory,
    files: nativeStrategyCliFiles(authority),
    cap: nativeStrategyDocuments(authority),
    revoke: () => {
      active = false;
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("creates complete private templates only when absent and reads actual native documents", async () => {
  const f = fixture();
  expect(await f.files.createAbsent?.("strategy.yaml", "version: 1\r\n")).toBe("created");
  expect(await f.files.createAbsent?.("strategy.yaml", "overwritten")).toBe("exists");
  expect(await f.files.createAbsent?.("strategy.md", "# Synthetic strategy\n")).toBe("created");
  expect(readFileSync(join(f.directory, "strategy.yaml"), "utf8")).toBe("version: 1\r\n");
  expect(await f.files.read("strategy.yaml")).toBe("version: 1\n");
  expect(f.cap.isCurrent()).toBe(true);
  const docs = await discoverStrategies(f.cap.documents);
  expect(docs[0]?.files).toEqual(["strategy.md", "strategy.yaml"]);
  const main = docs[0];
  if (!main) throw new Error("missing_synthetic_main");
  expect(await readStrategyFile(f.cap.documents, main, "strategy.md")).toEqual({
    ok: true,
    text: "# Synthetic strategy\n",
  });
  expect(await f.cap.filePath?.(main, "strategy.md")).toBe(join(f.directory, "strategy.md"));
});

it("refuses a competing target, unsafe links and revoked directory authority", async () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  writeFileSync(outside, "outside", { mode: 0o600 });
  symlinkSync(outside, join(f.directory, "strategy.yaml"));
  await expect(f.files.createAbsent?.("strategy.yaml", "new")).rejects.toThrow();
  rmSync(join(f.directory, "strategy.yaml"));
  linkSync(outside, join(f.directory, "strategy.yaml"));
  await expect(f.files.createAbsent?.("strategy.yaml", "new")).rejects.toThrow();
  rmSync(join(f.directory, "strategy.yaml"));
  expect(await f.files.createAbsent?.("strategy.yaml", "safe")).toBe("created");
  f.revoke();
  await expect(f.files.createAbsent?.("strategy.md", "blocked")).rejects.toThrow();
  await expect(f.files.replaceForced?.("strategy.yaml", "blocked")).rejects.toThrow();
  expect(f.cap.isCurrent()).toBe(false);
  expect(readFileSync(join(f.directory, "strategy.yaml"), "utf8")).toBe("safe");
});

it("uses explicit force for atomic per-file replacement and leaves the other file alone", async () => {
  const f = fixture();
  await f.files.createAbsent?.("strategy.yaml", "old yaml");
  await f.files.createAbsent?.("strategy.md", "old note");
  await f.files.replaceForced?.("strategy.yaml", "new yaml");
  expect(readFileSync(join(f.directory, "strategy.yaml"), "utf8")).toBe("new yaml");
  expect(readFileSync(join(f.directory, "strategy.md"), "utf8")).toBe("old note");
  expect(await f.files.createAbsent?.("strategy.yaml", "collision")).toBe("exists");
});

it("refuses a file created after an earlier absence check without replacing its bytes", async () => {
  const f = fixture();
  expect(await f.files.exists("strategy.yaml")).toBe(false);
  writeFileSync(join(f.directory, "strategy.yaml"), "concurrent owner edit", { mode: 0o600 });
  expect(await f.files.createAbsent?.("strategy.yaml", "template")).toBe("exists");
  expect(readFileSync(join(f.directory, "strategy.yaml"), "utf8")).toBe("concurrent owner edit");
});

it("recovers an interrupted owned link publication after reopening the capability", async () => {
  const f = fixture();
  const orphan = join(f.directory, ".strategy.yaml.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.creating");
  writeFileSync(orphan, "unrelated previous stage", { mode: 0o600 });
  const stage = join(f.directory, ".strategy.yaml.12345678-1234-1234-1234-123456789abc.creating");
  writeFileSync(stage, "complete synthetic template", { mode: 0o600 });
  linkSync(stage, join(f.directory, "strategy.yaml"));
  const reopened = nativeStrategyCliFiles({
    vault: "synthetic-vault",
    privateRoot: f.root,
    directory: f.directory,
    isCurrent: () => true,
  });
  expect(await reopened.read("strategy.yaml")).toBe("complete synthetic template");
  expect(await reopened.exists("strategy.yaml")).toBe(true);
  expect(readFileSync(join(f.directory, "strategy.yaml"), "utf8")).toBe(
    "complete synthetic template",
  );
  expect(existsSync(stage)).toBe(false);
  expect(readFileSync(orphan, "utf8")).toBe("unrelated previous stage");
  expect(await reopened.createAbsent?.("strategy.yaml", "different")).toBe("exists");
});

it("rejects symlinked strategy folders and a changed document while keeping the main files", async () => {
  const f = fixture();
  await f.files.createAbsent?.("strategy.md", "# Main\n");
  const outside = join(f.root, "outside-dir");
  mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, "unsafe.md"), "outside", { mode: 0o600 });
  symlinkSync(outside, join(f.directory, "strategies"));
  linkSync(join(outside, "unsafe.md"), join(f.directory, "linked.md"));
  const docs = await discoverStrategies(f.cap.documents);
  expect(docs).toHaveLength(1);
  expect(docs[0]?.files).toEqual(["strategy.md"]);
  await expect(f.cap.documents.list(["strategies"])).rejects.toThrow();
  expect((await f.cap.documents.list([]))?.find((entry) => entry.name === "linked.md")?.kind).toBe(
    "other",
  );
  const main = docs[0];
  if (!main) throw new Error("missing_synthetic_main");
  expect(await f.cap.filePath?.(main, "../unsafe.md")).toBeNull();
});

it("closes and invalidates a failed native watcher without an unhandled error", () => {
  const f = fixture();
  let fail: ((error: Error) => void) | undefined;
  let closes = 0;
  let changes = 0;
  const cap = nativeStrategyDocuments(
    {
      vault: "synthetic-vault",
      privateRoot: f.root,
      directory: f.directory,
      isCurrent: () => true,
    },
    {
      watchDirectory: () => ({
        on(_event, listener) {
          fail = listener;
        },
        close() {
          closes++;
        },
      }),
    },
  );
  const stop = cap.watch?.(() => {
    changes++;
  });
  expect(cap.isCurrent()).toBe(true);
  fail?.(new Error("synthetic_watcher_failure"));
  expect(cap.isCurrent()).toBe(false);
  expect(changes).toBe(1);
  expect(closes).toBe(1);
  fail?.(new Error("repeated_failure"));
  expect(changes).toBe(1);
  stop?.();
});
