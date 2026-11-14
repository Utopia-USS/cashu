import type { HostSession } from "@cashu/node-host";
import { defineQuery, type QueryArgs } from "@cashu/store/query";
import { expect, it } from "vitest";
import { memoryLog } from "./log.js";
import { serveStoreChannel } from "./storeChannel.js";
import type { HostStores, OpenVault } from "./stores.js";

const VAULT = "c".repeat(32);

/** One native-like vault whose sync settles on demand, behind a fake ui session. */
function channel(vaultOpenedLater = false) {
  let value = "first";
  const tableListeners = new Set<() => void>();
  const settled = new Set<() => void>();
  const source = {
    read: () => [{ value }],
    tablesRead: () => new Set(["synthetic_values"]),
    subscribe(_tables: Iterable<string>, listener: () => void) {
      tableListeners.add(listener);
      return () => tableListeners.delete(listener);
    },
  };
  const vault = {
    id: VAULT,
    mode: "native",
    store: source,
    native: {
      isCurrent: () => true,
      isSyncing: () => false,
      onSyncSettled(listener: () => void) {
        settled.add(listener);
        return () => settled.delete(listener);
      },
    },
  } as unknown as OpenVault;
  const vaults = new Map<string, OpenVault>(vaultOpenedLater ? [] : [[VAULT, vault]]);
  const stores = { device: {}, vaults } as unknown as HostStores;
  const frames: unknown[] = [];
  let onFrame: ((frame: unknown) => void) | undefined;
  let onClose: (() => void) | undefined;
  const session = {
    role: "ui",
    send: (frame: { m: unknown }) => frames.push(frame.m),
    onFrame: (handler: (frame: unknown) => void) => {
      onFrame = handler;
    },
    onClose: (handler: () => void) => {
      onClose = handler;
    },
    close: () => {},
  } as unknown as HostSession;
  serveStoreChannel(session, {
    stores,
    log: memoryLog(),
    commands: [],
    queries: [
      defineQuery({
        id: "synthetic.value",
        run: (read) => read<{ value: string }>("SELECT value FROM synthetic_values")[0]?.value,
      }) as never,
    ],
  });
  const send = (m: unknown) => onFrame?.({ t: "store", m });
  return {
    frames,
    values: () =>
      frames.filter((f): f is { t: "value" } => (f as { t: string }).t === "value").length,
    open: () => vaults.set(VAULT, vault),
    subscribe: () => {
      send({ t: "uiPolicy", generation: 1, privacy: false });
      send({
        t: "sub",
        sid: 1,
        generation: 1,
        resume: false,
        target: { kind: "vault", vault: VAULT },
        query: "synthetic.value",
        args: null as QueryArgs,
      });
    },
    settle: (next: string) => {
      value = next;
      for (const listener of [...settled]) listener();
    },
    hooks: () => settled.size,
    close: () => onClose?.(),
  };
}

it("re-sends a live query after a sync pass only when its encoded value changed", () => {
  const c = channel();
  c.subscribe();
  expect(c.values()).toBe(1);
  c.settle("first");
  expect(c.values()).toBe(1);
  c.settle("second");
  expect(c.values()).toBe(2);
  c.settle("second");
  expect(c.values()).toBe(2);
  c.close();
  expect(c.hooks()).toBe(0);
});

it("hooks the sync of a vault opened after the session started", () => {
  const c = channel(true);
  c.open();
  c.subscribe();
  expect(c.values()).toBe(1);
  expect(c.hooks()).toBe(1);
  c.settle("second");
  expect(c.values()).toBe(2);
  c.close();
});
