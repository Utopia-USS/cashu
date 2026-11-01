// Refusals before anything is opened (S31a spec 2.3, D5 / D6): the owner's real data dir, workspaces
// and app, git work trees, outputs inside the data dir, lab key files outside the lab root; init on a
// database that already holds a linked vault. Fake home dirs, synthetic data only. (The daemon's
// lockfile is gone: the host's machine lock and exclusive vault opens replace it, service.test.ts.)
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefusalError } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { crypto } from "@cashu/sync";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_CONFIG_FILE, loadConfig } from "./config.js";
import { InitRefusedError, initVaults } from "./init.js";
import { labFileKeyStore } from "./keys/labFile.js";
import { PythonReader } from "./python/reader.js";
import { SyntheticPython } from "./testing/python.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function home() {
  const h = mkdtempSync(join(tmpdir(), "cashu-bridge-home-"));
  roots.push(h);
  const lab = join(h, "cashu-lab", "run");
  mkdirSync(join(lab, "data"), { recursive: true });
  return { h, lab };
}

function configFile(lab: string, over: Record<string, unknown> = {}, dataDir = join(lab, "data")) {
  const config = {
    format: 2,
    python: { argv: ["/bin/false"], env: {} },
    stateRoot: join(lab, "state"),
    remotes: [{ kind: "folder", root: join(lab, "remote") }],
    keys: { kind: "lab-file", path: join(lab, "keys.json"), pythonKeyring: join(lab, "kr.json") },
    ...over,
  };
  writeFileSync(join(dataDir, BRIDGE_CONFIG_FILE), JSON.stringify(config));
  return dataDir;
}

describe("loadConfig", () => {
  it("accepts a lab run layout", () => {
    const { h, lab } = home();
    const config = loadConfig(configFile(lab), h);
    expect(config?.pollMs).toBe(2000);
    expect(config?.carrierMs).toBe(60_000);
    expect(config?.dataDir).toBe(join(lab, "data"));
  });

  it("is off without a configuration file", () => {
    const { h, lab } = home();
    expect(loadConfig(join(lab, "data"), h)).toBeUndefined();
  });

  it("refuses the real data dir as the host's data dir", () => {
    const { h, lab } = home();
    const real = join(h, "Library", "Application Support", "cashU");
    mkdirSync(real, { recursive: true });
    expect(() => loadConfig(configFile(lab, {}, real), h)).toThrow(RefusalError);
  });

  it("refuses the daemon's format 1 (it named its own data dir)", () => {
    const { h, lab } = home();
    expect(() => loadConfig(configFile(lab, { format: 1, dataDir: join(lab, "data") }), h)).toThrow(
      RefusalError,
    );
  });

  it.each([
    ["the real workspaces", (h: string) => ({ stateRoot: join(h, "Documents", "cashU", "x") })],
    ["the installed app", () => ({ stateRoot: "/Applications/cashU.app/Contents/x" })],
    [
      "keys outside the lab",
      (h: string, lab: string) => ({
        keys: { kind: "lab-file", path: join(h, "keys.json"), pythonKeyring: join(lab, "kr.json") },
      }),
    ],
    [
      "the state inside the data dir",
      (_h: string, lab: string) => ({ stateRoot: join(lab, "data", "state") }),
    ],
    ["a relative path", () => ({ stateRoot: "state" })],
  ])("refuses %s", (_name, over) => {
    const { h, lab } = home();
    expect(() => loadConfig(configFile(lab, over(h, lab)), h)).toThrow(RefusalError);
  });

  it("refuses an output inside a git work tree", () => {
    const { h, lab } = home();
    mkdirSync(join(lab, "repo", ".git"), { recursive: true });
    const dataDir = configFile(lab, { stateRoot: join(lab, "repo", "state") });
    expect(() => loadConfig(dataDir, h)).toThrow(RefusalError);
  });
});

describe("initVaults", () => {
  it("refuses a database that already holds a linked vault (D5: quiescent first start only)", async () => {
    const { h, lab } = home();
    const py = new SyntheticPython();
    roots.push(py.dir);
    py.profile(1, "syn-1");
    py.link(1, "ab".repeat(16));
    const reader = new PythonReader(py.dir);
    const sodium = await crypto.loadNodeSodium();
    const config = loadConfig(configFile(lab), h);
    if (config === undefined) throw new Error("no config");
    await expect(
      initVaults({
        config,
        reader,
        cli: py.cli(),
        sodium,
        keyStore: labFileKeyStore(join(lab, "keys.json")),
        openDb: (path) => openNodeSqlite(path),
        now: Date.UTC(2026, 2, 1),
        out: () => undefined,
      }),
    ).rejects.toThrow(InitRefusedError);
    reader.close();
    py.close();
  });
});

describe("the lab key file (review F8)", () => {
  it("keeps the lab key file 0600 in a 0700 directory", async () => {
    const { lab } = home();
    const path = join(lab, "keys", "k.json");
    await labFileKeyStore(path).set("cashu.test", new Uint8Array([1, 2, 3]));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(lab, "keys")).mode & 0o777).toBe(0o700);
    expect(await labFileKeyStore(path).get("cashu.test")).toEqual(new Uint8Array([1, 2, 3]));
  });
});
