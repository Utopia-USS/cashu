import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CurrentStrategyImage } from "@cashu/store/investments/screen-sources";
import type { Read } from "@cashu/store/query";
import { afterEach, describe, expect, it } from "vitest";
import { strategiesScreen } from "../strategiesScreen.js";
import { syntheticStrategyDocuments } from "./strategyDocuments.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(beforePublish?: (name: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cashu-synthetic-strategy-")));
  roots.push(root);
  const cap = await syntheticStrategyDocuments({
    root,
    vault: "synthetic-vault",
    generation: "synthetic-generation",
    isCurrent: () => true,
    ...(beforePublish ? { beforePublish } : {}),
  });
  return { root, cap };
}
describe("synthetic private file capability", () => {
  it("publishes complete staged contents and never overwrites an intervening final target", async () => {
    let root = "";
    const f = await fixture(async (name) => {
      await writeFile(join(root, name), "concurrent owner text", { mode: 0o600, flag: "wx" });
    });
    root = f.root;
    expect(await f.cap.createAbsent?.create("strategy.yaml", "new template")).toEqual({
      status: "exists",
    });
    expect(await readFile(join(root, "strategy.yaml"), "utf8")).toBe("concurrent owner text");
    expect(await readdir(root)).toEqual(["strategy.yaml"]);
  });
  it("publication failure cleans only its own temporary and preserves earlier successful targets", async () => {
    const f = await fixture(async (name) => {
      if (name === "strategy.md") throw new Error("synthetic publication failure");
    });
    expect(await f.cap.createAbsent?.create("strategy.yaml", "complete yaml")).toEqual({
      status: "created",
    });
    await expect(f.cap.createAbsent?.create("strategy.md", "complete markdown")).rejects.toThrow(
      "synthetic publication failure",
    );
    expect(await readFile(join(f.root, "strategy.yaml"), "utf8")).toBe("complete yaml");
    expect(await readdir(f.root)).toEqual(["strategy.yaml"]);
  });
  it("rejects symlinks at root, intermediate and file segments", async () => {
    const f = await fixture();
    const outside = await fixture();
    await writeFile(join(outside.root, "outside.md"), "outside private prose", { mode: 0o600 });
    await symlink(outside.root, join(f.root, "strategies"));
    expect(await f.cap.documents.readText(["strategies", "outside.md"])).toBeNull();
    await symlink(join(outside.root, "outside.md"), join(f.root, "strategy.md"));
    expect(await f.cap.files.read("strategy.md")).toMatchObject({
      error: "strategy_file_unreadable",
    });
    const alias = join(f.root, "alias");
    await symlink(outside.root, alias);
    await expect(
      syntheticStrategyDocuments({
        root: alias,
        vault: "synthetic",
        generation: "synthetic",
        isCurrent: () => true,
      }),
    ).rejects.toThrow("invalid_synthetic_strategy_root");
  });
  it("keeps main fatal UTF8 distinct from document replacement decoding", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "strategy.md"), Uint8Array.from([0xff]), { mode: 0o600 });
    expect(await f.cap.files.read("strategy.md")).toMatchObject({
      error: "strategy_file_unreadable",
    });
    expect(await f.cap.documents.readText(["strategy.md"])).toBe("\ufffd");
    await mkdir(join(f.root, "nested"), { mode: 0o700 });
  });
  it("manager retains fatal main read error alongside replacement-decoded viewer text", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "strategy.yaml"), Uint8Array.from([0xff, 0x0a]), { mode: 0o600 });
    const published: CurrentStrategyImage[] = [];
    const manager = strategiesScreen({
      bind: () => f.cap,
      publish(image) {
        published.push(image);
        return true;
      },
      revoke() {},
    });
    const read: Read = <T>() => [{ gid: f.cap.vault }] as T[];
    try {
      await manager.prepare(f.cap.vault, { document: "_main", path: "strategy.yaml" });
      expect(manager.source.current(read)?.selected).toMatchObject({
        status: "ready",
        text: "�\n",
      });
      expect(published[0]?.files.readError).not.toBeNull();
      expect(published[0]?.files.yaml).toBeNull();
    } finally {
      manager.close();
    }
  });
});
