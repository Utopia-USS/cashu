import type { StrategyDocsDir, StrategyFilesPort } from "@cashu/store/investments/services";
import type { Read } from "@cashu/store/query";
import { describe, expect, it } from "vitest";
import { type StrategyScreenCapability, strategiesScreen } from "./strategiesScreen.js";

function fixture() {
  const texts = new Map<string, string>([
    ["strategy.yaml", "version: 1\nbase_currency: PLN\n"],
    ["strategy.md", "# Synthetic strategy\n"],
  ]);
  let active = true;
  let onRead: (() => void) | null = null;
  const files: StrategyFilesPort = {
    async read(name) {
      onRead?.();
      return texts.get(name) ?? null;
    },
    async exists(name) {
      return texts.has(name);
    },
    async write() {
      throw new Error("not_allowed");
    },
  };
  const documents: StrategyDocsDir = {
    async list(path) {
      return path.length === 0
        ? [...texts].map(([name, text]) => ({ name, kind: "file" as const, size: text.length }))
        : null;
    },
    async readText(path) {
      return texts.get(path.join("/")) ?? null;
    },
  };
  const cap: StrategyScreenCapability = {
    vault: "synthetic-vault",
    generation: "generation-a",
    files,
    documents,
    isCurrent: () => active,
  };
  let bound = cap;
  let revoked = 0;
  const published: unknown[] = [];
  const manager = strategiesScreen({
    bind: () => bound,
    publish(image) {
      published.push(image);
      return active;
    },
    revoke() {
      revoked++;
    },
  });
  const read: Read = <T>() => [{ gid: cap.vault }] as T[];
  return {
    texts,
    cap,
    manager,
    published,
    read,
    revoke() {
      active = false;
    },
    replace(value: StrategyScreenCapability) {
      bound = value;
    },
    revoked: () => revoked,
    onRead(value: (() => void) | null) {
      onRead = value;
    },
  };
}
describe("strategy screen coherent source", () => {
  it("revokes a failed current watcher but not a replaced generation", async () => {
    const f = fixture();
    let changed: (() => void) | undefined;
    Object.assign(f.cap, {
      watch: (callback: () => void) => {
        changed = callback;
        return () => {};
      },
    });
    await f.manager.prepare(f.cap.vault);
    f.revoke();
    changed?.();
    expect(f.revoked()).toBe(1);
    f.manager.close();

    const g = fixture();
    let staleChanged: (() => void) | undefined;
    Object.assign(g.cap, {
      watch: (callback: () => void) => {
        staleChanged = callback;
        return () => {};
      },
    });
    await g.manager.prepare(g.cap.vault);
    g.replace({ ...g.cap, generation: "replacement", isCurrent: () => true });
    g.revoke();
    staleChanged?.();
    expect(g.revoked()).toBe(1);
    g.manager.close();

    const h = fixture();
    let oldChanged: (() => void) | undefined;
    Object.assign(h.cap, {
      watch: (callback: () => void) => {
        oldChanged = callback;
        return () => {};
      },
    });
    await h.manager.prepare(h.cap.vault);
    h.replace({ ...h.cap, generation: "replacement", isCurrent: () => true, watch: undefined });
    await h.manager.prepare(h.cap.vault);
    h.revoke();
    oldChanged?.();
    expect(h.revoked()).toBe(0);
    h.manager.close();
  });
  it("moves the watcher to a replacement generation and ignores a queued old callback", async () => {
    const f = fixture();
    let oldChanged: (() => void) | undefined;
    let newChanged: (() => void) | undefined;
    let oldStops = 0;
    Object.assign(f.cap, {
      watch: (callback: () => void) => {
        oldChanged = callback;
        return () => {
          oldStops++;
        };
      },
    });
    await f.manager.prepare(f.cap.vault);
    f.replace({
      ...f.cap,
      generation: "replacement",
      watch: (callback) => {
        newChanged = callback;
        return () => {};
      },
    });
    await f.manager.prepare(f.cap.vault);
    expect(oldStops).toBe(1);
    expect(newChanged).toBeTypeOf("function");
    oldChanged?.();
    expect(f.revoked()).toBe(0);
    newChanged?.();
    await expect.poll(() => f.published.length).toBe(3);
    f.manager.close();
  });
  it("hydrates actual default file and distinguishes deletion from history", async () => {
    const f = fixture();
    await f.manager.prepare(f.cap.vault);
    const image = f.manager.source.current(f.read);
    expect(image?.selected).toMatchObject({
      status: "ready",
      selection: { document: "_main", path: "strategy.md" },
      text: "# Synthetic strategy\n",
    });
    const revision = image?.revision;
    f.texts.delete("strategy.yaml");
    await f.manager.prepare(f.cap.vault);
    expect(f.manager.source.current(f.read)).toMatchObject({ yamlExists: false, mdExists: true });
    expect(f.manager.source.current(f.read)?.revision).not.toBe(revision);
    f.manager.close();
  });
  it("revocation after an await publishes no private snapshot", async () => {
    const f = fixture();
    f.onRead(() => f.revoke());
    await expect(f.manager.prepare(f.cap.vault)).rejects.toThrow("authority_lost");
    expect(f.published).toHaveLength(0);
    expect(f.manager.source.current(f.read)).toBeNull();
  });
  it("refuses mixed main source and current validation images", async () => {
    const f = fixture();
    let calls = 0;
    f.onRead(() => {
      calls++;
      if (calls === 3) f.texts.set("strategy.yaml", "version: 2\n");
    });
    await expect(
      f.manager.prepare(f.cap.vault, { document: "_main", path: "strategy.yaml" }),
    ).rejects.toThrow("stale_revision");
    expect(f.published).toHaveLength(0);
  });
  it("replaces current snapshot on file-only edits and clears it on teardown", async () => {
    const f = fixture();
    let notifications = 0;
    f.manager.source.changes.subscribe(() => {
      notifications++;
    });
    await f.manager.prepare(f.cap.vault);
    f.texts.set("strategy.md", "# Changed synthetic document\n");
    await f.manager.prepare(f.cap.vault);
    expect(f.manager.source.current(f.read)?.documents[0]?.title).toBe(
      "Changed synthetic document",
    );
    expect(notifications).toBe(2);
    f.manager.close();
    expect(f.manager.source.current(f.read)).toBeNull();
  });
  it("serializes independent current consumers without revoking either", async () => {
    const f = fixture();
    await Promise.all([
      f.manager.prepare(f.cap.vault),
      f.manager.prepare(f.cap.vault, { document: "_main", path: "strategy.yaml" }),
    ]);
    const image = f.manager.source.current(f.read);
    expect(image?.loaded).toHaveLength(2);
    expect(image?.loaded?.find((entry) => entry.requested === null)?.file).toMatchObject({
      status: "ready",
      selection: { path: "strategy.md" },
    });
    expect(
      image?.loaded?.find((entry) => entry.requested?.path === "strategy.yaml")?.file,
    ).toMatchObject({ status: "ready", selection: { path: "strategy.yaml" } });
    expect(f.published).toHaveLength(2);
    expect((f.published[0] as { revision: string }).revision).toBe(
      (f.published[1] as { revision: string }).revision,
    );
    f.manager.close();
  });
});
