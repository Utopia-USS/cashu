import type { Read } from "@cashu/store/query";
import { expect, it, vi } from "vitest";
import { settingsWorkspaceStatus } from "./settingsScreen.js";
import type { HostStores } from "./stores.js";
import type { WorkspaceProvider, WorkspaceStatus } from "./workspace/index.js";

const vault = "a".repeat(32);

function fixture() {
  let modules = ["budget"];
  let edits = 0;
  const providerListeners = new Set<(vault: string) => void>();
  const watched: { path: string; changed: () => void; stopped: boolean }[] = [];
  const inspect = vi.fn(
    async (input: { modules: readonly { id: string }[] }): Promise<WorkspaceStatus> =>
      ({
        availability: "ready",
        path: "/synthetic/workspace",
        modules: input.modules.map((m) => m.id),
        edits,
      }) as unknown as WorkspaceStatus,
  );
  const provider: WorkspaceProvider = {
    bind: () => ({
      generation: "g1",
      isCurrent: () => true,
      inspect,
      apply: async () => ({ kind: "refused", code: "busy" }),
    }),
    changes: {
      subscribe(listener) {
        providerListeners.add(listener);
        return () => providerListeners.delete(listener);
      },
    },
  };
  const stores = { vaults: new Map([[vault, {}]]) } as unknown as HostStores;
  const query = settingsWorkspaceStatus({
    provider,
    stores: () => stores,
    watch: (path, changed) => {
      const entry = { path, changed, stopped: false };
      watched.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
  });
  const read = ((sql: string) => {
    if (sql.includes("profile_modules")) return modules.map((module_id) => ({ module_id }));
    if (sql.includes("slug"))
      return [{ slug: "synthetic", baseCurrency: "PLN", mcpPrivacy: "strict" }];
    return [{ gid: vault }];
  }) as Read;
  return {
    query,
    run: () => query.run(read, undefined),
    inspect,
    watched,
    setModules: (next: string[]) => {
      modules = next;
    },
    editOnDisk: () => {
      edits++;
      for (const entry of watched) if (!entry.stopped) entry.changed();
    },
    written: () => {
      for (const listener of [...providerListeners]) listener(vault);
    },
  };
}

it("inspects the workspace by itself and again after a write, a profile change and an edit on disk", async () => {
  const f = fixture();
  const pushed = vi.fn();
  const stop = f.query.changes?.subscribe(pushed) ?? (() => {});
  expect(f.run()).toEqual({ status: "loading" });
  await vi.waitFor(() => expect(f.run()).toMatchObject({ status: "ready", checking: false }));
  expect(f.watched.map((w) => w.path)).toEqual(["/synthetic/workspace"]);

  f.editOnDisk();
  expect(f.run()).toMatchObject({ status: "ready", checking: true });
  await vi.waitFor(() =>
    expect(f.run()).toMatchObject({ status: "ready", checking: false, workspace: { edits: 1 } }),
  );

  // Each push re-runs the live query, which asks for the fresh inspection.
  f.written();
  expect(f.run()).toMatchObject({ status: "ready", checking: true });
  await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledTimes(3));

  f.setModules(["budget", "investments"]);
  await vi.waitFor(() =>
    expect(f.run()).toMatchObject({
      status: "ready",
      checking: false,
      workspace: { modules: ["budget", "investments"] },
    }),
  );
  expect(pushed).toHaveBeenCalled();

  stop();
  expect(f.watched.every((w) => w.stopped)).toBe(true);
});
