/// <reference types="node" />
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  type HostRuntime,
  pythonProgram,
  shimProgram,
  shippedConnectorsSource,
  shippedSkillsSource,
} from "./runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packaged(env: Record<string, string | undefined> = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-host-runtime-")));
  roots.push(root);
  const resources = join(root, "cashU.app", "Contents", "Resources");
  const skills = join(resources, "skills");
  const connectors = join(resources, "connectors");
  const dataDir = join(root, "data");
  mkdirSync(skills, { recursive: true });
  mkdirSync(connectors);
  mkdirSync(dataDir);
  const rt: HostRuntime = {
    checkout: undefined,
    dir: resources,
    execPath: join(root, "cashU.app", "Contents", "MacOS", "cashU"),
    execArgv: [],
    cwd: root,
    env: { CASHU_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: "1", ...env },
  };
  return { rt, root, resources, skills, connectors, dataDir };
}

it("uses independent packaged skills and connectors beside host.mjs", () => {
  const b = packaged();
  expect(shippedSkillsSource(b.rt)).toBe(b.skills);
  expect(shippedConnectorsSource(b.rt)).toBe(b.connectors);
  expect(pythonProgram(b.rt)).toBeUndefined();
  expect(shimProgram(b.rt)).toEqual({
    command: b.rt.execPath,
    args: [join(b.resources, "shim.mjs")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
});

it("refuses packaged resource symlinks escaping the bundle", () => {
  const b = packaged({ CASHU_PYTHON_CLI: "/tmp/other" });
  expect(pythonProgram(b.rt)).toBeUndefined();
  const outside = join(b.root, "other");
  writeFileSync(outside, "synthetic");
  rmSync(b.skills, { recursive: true });
  symlinkSync(outside, b.skills);
  expect(shippedSkillsSource(b.rt)).toBeUndefined();
  rmSync(b.connectors, { recursive: true });
  symlinkSync(outside, b.connectors);
  expect(shippedConnectorsSource(b.rt)).toBeUndefined();
});
