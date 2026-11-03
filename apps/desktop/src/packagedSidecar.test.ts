/// <reference types="node" />
import type { spawnSync } from "node:child_process";
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
import { packagedSidecarSpec, verifyPackagedDataDir } from "./packagedSidecar.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bundle() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-packaged-python-")));
  roots.push(root);
  const resources = join(root, "cashU.app", "Contents", "Resources");
  const python = join(resources, "python");
  mkdirSync(python, { recursive: true });
  const executable = join(python, "cashu-python");
  writeFileSync(executable, "synthetic executable");
  chmodSync(executable, 0o755);
  return { root, resources, python, executable };
}

it("selects only the fixed executable and serve contract", () => {
  const b = bundle();
  expect(packagedSidecarSpec(b.resources, {})).toEqual({
    command: b.executable,
    args: ["serve"],
    cwd: b.python,
  });
  expect(() =>
    packagedSidecarSpec(b.resources, { CASHU_DESKTOP_SIDECAR_BIN: "/tmp/other" }),
  ).toThrow(/overrides/);
  expect(() => packagedSidecarSpec(b.resources, { CASHU_DESKTOP_SIDECAR_ARGS: '["x"]' })).toThrow(
    /overrides/,
  );
});

it("refuses a linked or non-executable resource", () => {
  const b = bundle();
  chmodSync(b.executable, 0o644);
  expect(() => packagedSidecarSpec(b.resources, {})).toThrow(/executable regular file/);
  rmSync(b.executable);
  const outside = join(b.root, "outside");
  writeFileSync(outside, "synthetic");
  symlinkSync(outside, b.executable);
  expect(() => packagedSidecarSpec(b.resources, {})).toThrow(/escapes Resources/);
});

it("preflights the exact data dir with a scrubbed Python environment", () => {
  const b = bundle();
  const spec = packagedSidecarSpec(b.resources, {});
  const expected = join(b.root, "data");
  const calls: unknown[][] = [];
  const fake = ((...args: unknown[]) => {
    calls.push(args);
    return { status: 0, stdout: `${expected}\n`, stderr: "" };
  }) as unknown as typeof spawnSync;
  expect(
    verifyPackagedDataDir(
      spec,
      expected,
      { PYTHONPATH: "/tmp/other", DYLD_INSERT_LIBRARIES: "/tmp/other", LD_PRELOAD: "/tmp/other" },
      fake,
    ),
  ).toBeNull();
  expect(calls[0]?.[0]).toBe(b.executable);
  expect(calls[0]?.[1]).toEqual(["--preflight-data-dir"]);
  const options = calls[0]?.[2] as { env: Record<string, string>; cwd: string };
  expect(options.env.CASHU_DATA_DIR).toBe(expected);
  expect(options.env.PYTHONPATH).toBeUndefined();
  expect(options.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
  expect(options.env.LD_PRELOAD).toBeUndefined();
  expect(options.cwd).toBe(b.python);
  const wrong = (() => ({
    status: 0,
    stdout: `${join(b.root, "other")}\n`,
    stderr: "",
  })) as unknown as typeof spawnSync;
  expect(verifyPackagedDataDir(spec, expected, {}, wrong)).toMatch(/different data dir/);
  const failed = (() => ({
    status: 3,
    stdout: "",
    stderr: "refused",
  })) as unknown as typeof spawnSync;
  expect(verifyPackagedDataDir(spec, expected, {}, failed)).toMatch(/Could not preflight/);
});
