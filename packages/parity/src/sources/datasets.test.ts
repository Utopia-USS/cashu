/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DATASET_CLOCKS, datasetAsOf, datasetDir, labRoot } from "./datasets.ts";

const GOLDEN_PY = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "parity",
  "python",
  "golden.py",
);

describe("datasets", () => {
  it("clocks and dirs follow golden.py", () => {
    const golden = readFileSync(GOLDEN_PY, "utf8");
    const demoToday = /DEMO_TODAY = "([0-9-]+)"/.exec(golden)?.[1];
    expect(DATASET_CLOCKS.demo).toBe(`${demoToday}T12:00:00`);
    expect(golden).toContain(`"lab": "${DATASET_CLOCKS.lab}"`);
    expect(golden).toContain(
      'DATASETS = {"lab": LAB_ROOT / "data", "demo": PARITY_ROOT / "demo-data"}',
    );
    expect(datasetDir("lab", "/x")).toBe(join("/x", "data"));
    expect(datasetDir("demo", "/x")).toBe(join("/x", "parity", "demo-data"));
    expect(datasetAsOf("demo")).toBe("2026-10-01");
  });

  it("the lab root follows CASHU_LAB_DIR", () => {
    expect(labRoot({ CASHU_LAB_DIR: "/tmp/lab" })).toBe("/tmp/lab");
  });
});
