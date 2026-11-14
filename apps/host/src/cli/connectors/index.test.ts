import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "@cashu/i18n";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectorCatalog } from "../../connectors/catalog.js";
import type { CommandIo } from "../tree.js";
import { connectorCommands, shippedConnector } from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cashu-cli-connector-"));
  roots.push(root);
  const data = join(root, "data");
  const shipped = join(root, "shipped");
  const source = join(shipped, "sample-file");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(source, { mode: 0o700, recursive: true });
  writeFileSync(
    join(source, "connector.yaml"),
    "api_version: 1\nid: sample-file\nname: Sample\nversion: '1'\nmaintainer: Synthetic\nlast_verified: 2026-11-04\nmodule: budget\nkind: file\nrun: [python3, connector.py]\nfile:\n  extensions: [csv]\n",
  );
  writeFileSync(join(source, "connector.py"), "print('synthetic')\n");
  return { root, data, shipped, source };
}
function io(cwd: string) {
  const stdout = vi.fn();
  const stderr = vi.fn();
  const value: CommandIo = {
    cwd,
    env: {},
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout,
    stderr,
    prompt: async () => null,
    stdin: async function* () {},
  };
  return { value, stdout, stderr };
}

it("installs a shipped connector pending and refuses traversal", async () => {
  const f = fixture();
  const catalog = new ConnectorCatalog(f.data);
  const deps = { catalog, shippedCatalog: f.shipped };
  expect(shippedConnector(deps, "../data")).toBeNull();
  const command = connectorCommands(deps)[0];
  const output = io(f.root);
  expect(await command?.run(["catalog", "add", "sample-file"], output.value, {})).toBe(0);
  expect(catalog.list()[0]?.approval).toBe("pending");
  expect(await command?.run(["catalog", "add", "../data"], output.value, {})).toBe(1);
  expect(catalog.list()).toHaveLength(1);
});

it("never exposes secret mutation or approval through the CLI", async () => {
  const f = fixture();
  const catalog = new ConnectorCatalog(f.data);
  const command = connectorCommands({ catalog })[0];
  const output = io(f.root);
  expect(await command?.run(["secret", "set", "anything"], output.value, {})).toBe(69);
  expect(await command?.run(["disable", "sample-file"], output.value, {})).toBe(69);
  expect(catalog.list()).toEqual([]);
});

it("uses checked host controls for disable and confirmed unbound removal", async () => {
  const f = fixture();
  const catalog = new ConnectorCatalog(f.data);
  catalog.installPending(f.source);
  let current = true;
  const authority = { ownerAction: true as const, isCurrent: () => current };
  expect(() => catalog.removeUnbound("sample-file", authority, () => false)).toThrow(
    "references remain",
  );
  const disable = vi.fn(async () => {});
  const remove = vi.fn(async (id: string) => {
    catalog.removeUnbound(id, authority, () => true);
    return { bindings: 0 };
  });
  const command = connectorCommands({ catalog, disable, remove, isCurrent: () => current })[0];
  const output = io(f.root);
  expect(await command?.run(["disable", "sample-file"], output.value, {})).toBe(0);
  expect(disable).toHaveBeenCalledOnce();
  expect(await command?.run(["remove", "sample-file"], output.value, {})).toBe(69);
  expect(remove).not.toHaveBeenCalled();
  expect(await command?.run(["remove", "sample-file", "--yes"], output.value, {})).toBe(0);
  expect(catalog.list()).toEqual([]);
  current = false;
  expect(await command?.run(["list"], output.value, {})).toBe(69);
});
