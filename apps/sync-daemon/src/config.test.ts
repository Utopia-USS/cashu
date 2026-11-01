// Refusals before anything is opened (S31a spec 2.3, D5 / D6): the owner's real data dir, workspaces
// and app, git work trees, outputs inside the data dir, lab key files outside the lab root; a live
// lock; init on a database that already holds a linked vault. Fake home dirs, synthetic data only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefusalError } from "@cashu/node-host";
import { crypto } from "@cashu/sync";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { InitRefusedError, initVaults } from "./init.js";
import { labFileKeyStore } from "./keys/labFile.js";
import { acquireLock, LockedError } from "./lock.js";
import { PythonReader } from "./python/reader.js";
import { SyntheticPython } from "./testing/python.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function home() {
  const h = mkdtempSync(join(tmpdir(), "cashu-daemon-home-"));
  roots.push(h);
  const lab = join(h, "cashu-lab", "run");
  mkdirSync(join(lab, "data"), { recursive: true });
  return { h, lab };
}

function configFile(h: string, lab: string, over: Record<string, unknown> = {}) {
  const config = {
    format: 1,
    dataDir: join(lab, "data"),
    python: { argv: ["/bin/false"], env: {} },
    stateRoot: join(lab, "state"),
    remotes: [{ kind: "folder", root: join(lab, "remote") }],
    keys: { kind: "lab-file", path: join(lab, "keys.json"), pythonKeyring: join(lab, "kr.json") },
    ...over,
  };
  const path = join(h, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

describe("loadConfig", () => {
  it("accepts a lab run layout", () => {
    const { h, lab } = home();
    expect(loadConfig(configFile(h, lab), h).pollMs).toBe(2000);
  });

  it.each([
    [
      "the real data dir",
      (h: string) => ({ dataDir: join(h, "Library", "Application Support", "cashU") }),
    ],
    [
      "the real workspaces",
      (h: string, lab: string) => ({
        stateRoot: join(h, "Documents", "cashU", "x"),
        dataDir: join(lab, "data"),
      }),
    ],
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
    expect(() => loadConfig(configFile(h, lab, over(h, lab)), h)).toThrow(RefusalError);
  });

  it("refuses an output inside a git work tree", () => {
    const { h, lab } = home();
    mkdirSync(join(lab, "repo", ".git"), { recursive: true });
    const path = configFile(h, lab, { stateRoot: join(lab, "repo", "state") });
    expect(() => loadConfig(path, h)).toThrow(RefusalError);
  });
});

describe("acquireLock", () => {
  it("refuses a live holder and takes over a stale one", () => {
    const { lab } = home();
    const path = join(lab, "daemon.lock");
    const lock = acquireLock(path, 111, () => true);
    expect(() => acquireLock(path, 222, () => true)).toThrow(LockedError);
    const taken = acquireLock(path, 222, () => false);
    taken.release();
    lock.release();
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
    const config = loadConfig(configFile(h, lab), h);
    await expect(
      initVaults({
        config,
        reader,
        cli: py.cli(),
        sodium,
        keyStore: labFileKeyStore(join(lab, "keys.json")),
        now: Date.UTC(2026, 2, 1),
        out: () => undefined,
      }),
    ).rejects.toThrow(InitRefusedError);
    reader.close();
    py.close();
  });
});
