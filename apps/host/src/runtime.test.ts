/// <reference types="node" />
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkDir } from "@cashu/node-host/testing/links";
import { afterEach, expect, it } from "vitest";
import {
  type HostRuntime,
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
  expect(shimProgram(b.rt)).toEqual({
    command: b.rt.execPath,
    args: [join(b.resources, "shim.mjs")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
});

// POSIX spelling of the source paths; the Windows form (a file: URL) is @cashu/node-host sourceRun.test.
it.skipIf(process.platform === "win32")(
  "runs the source shim with this run's source flags and an absolute --import",
  () => {
    const rt: HostRuntime = {
      checkout: "/Synthetic/cashu",
      dir: "/Synthetic/cashu/apps/host/src",
      execPath: "/usr/bin/node",
      execArgv: [
        "--experimental-strip-types",
        "--import=./tools/node-ts/resolveTs.ts",
        "--inspect",
      ],
      cwd: "/Synthetic/cashu",
      env: {},
    };
    expect(shimProgram(rt)).toEqual({
      command: "/usr/bin/node",
      args: [
        "--experimental-transform-types",
        "--import=/Synthetic/cashu/tools/node-ts/resolveTs.ts",
        "/Synthetic/cashu/apps/cli/src/index.ts",
      ],
    });
  },
);

// Directory links: junctions on Windows (no privilege needed there).
it("refuses packaged resource symlinks escaping the bundle", () => {
  const b = packaged();
  const outside = join(b.root, "other");
  mkdirSync(outside);
  writeFileSync(join(outside, "README.md"), "synthetic");
  rmSync(b.skills, { recursive: true });
  linkDir(outside, b.skills);
  expect(shippedSkillsSource(b.rt)).toBeUndefined();
  rmSync(b.connectors, { recursive: true });
  linkDir(outside, b.connectors);
  expect(shippedConnectorsSource(b.rt)).toBeUndefined();
});
