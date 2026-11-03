/// <reference types="node" />
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type HostRuntime, pythonProgram, shimProgram, shippedSkillsSource } from "./runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packaged(env: Record<string, string | undefined> = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-host-runtime-")));
  roots.push(root);
  const resources = join(root, "cashU.app", "Contents", "Resources");
  const python = join(resources, "python");
  const skills = join(python, "_internal", "skills");
  const dataDir = join(root, "data");
  mkdirSync(skills, { recursive: true });
  mkdirSync(dataDir);
  const executable = join(python, "cashu-python");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$CASHU_DATA_DIR\"\n");
  chmodSync(executable, 0o755);
  const rt: HostRuntime = {
    checkout: undefined,
    dir: resources,
    execPath: join(root, "cashU.app", "Contents", "MacOS", "cashU"),
    execArgv: [],
    cwd: root,
    env: { CASHU_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: "1", ...env },
  };
  return { rt, root, resources, python, skills, dataDir, executable };
}

it("uses fixed packaged Python and shipped skills beside host.mjs", () => {
  const b = packaged();
  expect(shippedSkillsSource(b.rt)).toBe(b.skills);
  expect(pythonProgram(b.rt)).toEqual({
    command: b.executable,
    args: [],
    env: { CASHU_DATA_DIR: b.dataDir },
  });
  expect(shimProgram(b.rt)).toEqual({
    command: b.rt.execPath,
    args: [join(b.resources, "shim.mjs")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
});

it("refuses packaged Python redirection, missing data authority and resource symlinks", () => {
  const b = packaged({ CASHU_PYTHON_CLI: "/tmp/other" });
  expect(pythonProgram(b.rt)).toBeUndefined();
  expect(pythonProgram({ ...b.rt, env: {} })).toBeUndefined();
  const outside = join(b.root, "other");
  writeFileSync(outside, "synthetic");
  rmSync(b.executable);
  symlinkSync(outside, b.executable);
  expect(pythonProgram({ ...b.rt, env: { CASHU_DATA_DIR: b.dataDir } })).toBeUndefined();
});

it("refuses inherited Python or dynamic loader redirection before delegation", () => {
  const b = packaged();
  for (const key of [
    "PYTHONPATH",
    "_PYI_APPLICATION_HOME_DIR",
    "DYLD_INSERT_LIBRARIES",
    "LD_PRELOAD",
  ]) {
    expect(pythonProgram({ ...b.rt, env: { ...b.rt.env, [key]: "/tmp/other" } })).toBeUndefined();
  }
});

it("refuses a Python preflight mismatch", () => {
  const b = packaged();
  writeFileSync(b.executable, "#!/bin/sh\nprintf '/wrong/data\\n'\n");
  expect(pythonProgram(b.rt)).toBeUndefined();
});
