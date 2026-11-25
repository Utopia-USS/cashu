import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cashu-synthetic-strategy-")));
  roots.push(root);
  const cap = await syntheticStrategyDocuments({
    root,
    vault: "synthetic-vault",
    generation: "synthetic-generation",
    isCurrent: () => true,
  });
  return { root, cap };
}
describe("strategy screen over invalid UTF-8", () => {
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
