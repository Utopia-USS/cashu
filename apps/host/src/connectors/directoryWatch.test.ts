import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { watchDirectory } from "./directoryWatch.js";

const roots: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-watch-")));
  roots.push(root);
  return root;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

it("reports a change anywhere in the tree once per burst, and nothing after it stops", async () => {
  const dir = join(temp(), "installed-connectors");
  mkdirSync(join(dir, "synthetic"), { recursive: true });
  const changed = vi.fn();
  const stop = watchDirectory(dir, changed, { debounceMs: 20 });
  stops.push(stop);
  await settle();
  writeFileSync(join(dir, "synthetic", "manifest.json"), "{}");
  writeFileSync(join(dir, "synthetic", "run.sh"), "");
  await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 3000 });
  await settle();
  const calls = changed.mock.calls.length;
  expect(calls).toBeLessThanOrEqual(2);
  stop();
  writeFileSync(join(dir, "late.json"), "{}");
  await settle();
  await settle();
  expect(changed).toHaveBeenCalledTimes(calls);
});

it("waits for a directory that does not exist yet and follows it once created", async () => {
  const dir = join(temp(), "installed-connectors");
  const changed = vi.fn();
  stops.push(watchDirectory(dir, changed, { debounceMs: 20 }));
  await settle();
  expect(changed).not.toHaveBeenCalled();
  mkdirSync(dir);
  await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 3000 });
  await settle();
  const calls = changed.mock.calls.length;
  writeFileSync(join(dir, "synthetic.approval.json"), "{}");
  await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThan(calls), {
    timeout: 3000,
  });
});

it("never fails the caller when even the parent is missing", () => {
  const changed = vi.fn();
  const stop = watchDirectory(join(temp(), "missing", "installed-connectors"), changed);
  stop();
  expect(changed).not.toHaveBeenCalled();
});

it("lets the catalog's live list follow a connector copied in by hand while someone listens", async () => {
  const { ConnectorCatalog } = await import("./catalog.js");
  const catalog = new ConnectorCatalog(temp());
  const changed = vi.fn();
  const unsubscribe = catalog.changes.subscribe(changed);
  stops.push(() => catalog.close());
  await settle();
  mkdirSync(join(catalog.root, "synthetic"), { mode: 0o700 });
  await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 3000 });
  unsubscribe();
  await settle();
  const calls = changed.mock.calls.length;
  mkdirSync(join(catalog.root, "other"), { mode: 0o700 });
  await settle();
  await settle();
  expect(changed).toHaveBeenCalledTimes(calls);
});
