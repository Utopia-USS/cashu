/// <reference types="node" />
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { parseConfig } from "./config.ts";
import { sha256Hex } from "./json.ts";
import { formatReport } from "./report.ts";
import { goldenChecks, RunError, runParity } from "./run.ts";

let root: string;
const noConfig = parseConfig({});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cashu-parity-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write check files plus an index.json the way golden.py does (sha256 over the file bytes). */
function writeSet(dir: string, files: Record<string, string>, rows: Record<string, number> = {}) {
  mkdirSync(dir, { recursive: true });
  const checks = Object.entries(files).map(([check, text]) => {
    writeFileSync(join(dir, `${check}.json`), text);
    return { check, rows: rows[check] ?? 1, sha256: sha256Hex(text) };
  });
  writeFileSync(join(dir, "index.json"), JSON.stringify({ format: 1, checks }));
}

const GOLDEN = {
  "core.networth":
    '{"currencies":{"PLN":{"total":"100.50"}},"rows":[{"id":"account:0123456789abcdef"}]}\n',
  "budget.analytics": '{"ratio":0.123456789,"items":["a","b"]}\n',
};

describe("runParity", () => {
  it("passes when the actual dir is the golden dir", () => {
    const g = join(root, "golden");
    writeSet(g, GOLDEN);
    const report = runParity({ goldenDir: g, actualDir: g, config: noConfig });
    expect(report.counts).toEqual({ pass: 2, fail: 0, missing: 0 });
    expect(report.checks.map((c) => c.actualSha)).toEqual(report.checks.map((c) => c.goldenSha));
  });

  it("passes a deep comparison of identical files and of reordered keys", () => {
    const g = join(root, "golden");
    const a = join(root, "actual");
    writeSet(g, GOLDEN);
    expect(
      runParity({ goldenDir: g, actualDir: g, config: noConfig, deep: true }).counts.pass,
    ).toBe(2);
    writeSet(a, {
      "core.networth":
        '{"rows":[{"id":"account:0123456789abcdef"}],\n "currencies":{"PLN":{"total":"100.50"}}}',
      "budget.analytics": '{"items":["a","b"],"ratio":0.123456789}',
    });
    const report = runParity({ goldenDir: g, actualDir: a, config: noConfig });
    expect(report.counts).toEqual({ pass: 2, fail: 0, missing: 0 });
    expect(report.checks[0]?.actualSha).not.toBe(report.checks[0]?.goldenSha);
  });

  it("reports missing for every check when the actual dir does not exist", () => {
    const g = join(root, "golden");
    writeSet(g, GOLDEN);
    const report = runParity({ goldenDir: g, actualDir: join(root, "nope"), config: noConfig });
    expect(report.counts).toEqual({ pass: 0, fail: 0, missing: 2 });
    expect(report.checks.every((c) => c.status === "missing" && c.actualSha === null)).toBe(true);
  });

  it("reports missing for a check without an actual file and ignores nothing else", () => {
    const g = join(root, "golden");
    const a = join(root, "actual");
    writeSet(g, GOLDEN);
    writeSet(a, { "core.networth": GOLDEN["core.networth"], "extra.check": "{}" });
    const report = runParity({ goldenDir: g, actualDir: a, config: noConfig });
    expect(report.checks.map((c) => c.status)).toEqual(["pass", "missing"]);
    expect(report.extra).toEqual(["extra.check"]);
  });

  it("fails a planted diff with its path and no values", () => {
    const g = join(root, "golden");
    const a = join(root, "actual");
    writeSet(g, GOLDEN);
    writeSet(a, {
      ...GOLDEN,
      "core.networth": GOLDEN["core.networth"].replace("100.50", "100.51"),
    });
    const report = runParity({ goldenDir: g, actualDir: a, config: noConfig });
    expect(report.counts).toEqual({ pass: 1, fail: 1, missing: 0 });
    const failed = report.checks[0];
    expect(failed?.diff).toEqual({ path: "$.currencies.PLN.total", kind: "string" });
    const text = formatReport(report);
    expect(text).toContain("$.currencies.PLN.total");
    expect(text).not.toMatch(/100\.5/);
  });

  it("applies a per-check float tolerance and decimal policy from the config", () => {
    const g = join(root, "golden");
    const a = join(root, "actual");
    writeSet(g, GOLDEN);
    writeSet(a, {
      "core.networth": GOLDEN["core.networth"].replace("100.50", "100.5"),
      "budget.analytics": GOLDEN["budget.analytics"].replace("0.123456789", "0.1234568"),
    });
    expect(runParity({ goldenDir: g, actualDir: a, config: noConfig }).counts.fail).toBe(2);
    const config = parseConfig({
      checks: {
        "core.networth": { decimal: "numeric" },
        "budget.analytics": { absTol: 1e-6 },
      },
    });
    expect(runParity({ goldenDir: g, actualDir: a, config }).counts).toEqual({
      pass: 2,
      fail: 0,
      missing: 0,
    });
    // an override of one check does not loosen the other
    const onlyOne = parseConfig({ checks: { "budget.analytics": { absTol: 1e-6 } } });
    const r = runParity({ goldenDir: g, actualDir: a, config: onlyOne });
    expect(r.checks.map((c) => c.status)).toEqual(["fail", "pass"]);
  });

  it("fails an unparsable actual file with an offset only", () => {
    const g = join(root, "golden");
    const a = join(root, "actual");
    writeSet(g, { "core.networth": GOLDEN["core.networth"] });
    writeSet(a, { "core.networth": '{"currencies":{"SECRET":NaN}}' });
    const report = runParity({ goldenDir: g, actualDir: a, config: noConfig });
    expect(report.checks[0]?.diff?.kind).toBe("parse");
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("fails when the actual row count differs from the golden one", () => {
    const g = join(root, "golden");
    const a = join(root, "actual");
    writeSet(g, GOLDEN, { "core.networth": 2 });
    writeSet(a, GOLDEN, { "core.networth": 3 });
    writeFileSync(join(a, "core.networth.json"), `${GOLDEN["core.networth"]} `);
    const report = runParity({ goldenDir: g, actualDir: a, config: noConfig });
    expect(report.checks[0]?.diff).toEqual({ path: "index.rows", kind: "rows", detail: "2 vs 3" });
  });

  it("fails a golden file that no longer matches its index", () => {
    const g = join(root, "golden");
    writeSet(g, GOLDEN);
    writeFileSync(join(g, "core.networth.json"), "{}\n");
    const report = runParity({ goldenDir: g, actualDir: g, config: noConfig });
    expect(report.checks[0]?.status).toBe("fail");
    expect(report.checks[0]?.diff?.kind).toBe("golden-sha");
  });

  it("selects checks and rejects unknown names", () => {
    const g = join(root, "golden");
    writeSet(g, GOLDEN);
    const one = runParity({
      goldenDir: g,
      actualDir: g,
      config: noConfig,
      only: ["budget.analytics"],
    });
    expect(one.checks.map((c) => c.check)).toEqual(["budget.analytics"]);
    expect(() =>
      runParity({ goldenDir: g, actualDir: g, config: noConfig, only: ["nope"] }),
    ).toThrow(RunError);
    const typo = parseConfig({ checks: { "core.networht": { absTol: 1 } } });
    expect(() => runParity({ goldenDir: g, actualDir: g, config: typo })).toThrow(/unknown check/);
    expect(goldenChecks(g)).toEqual(["core.networth", "budget.analytics"]);
  });
});

describe("cli", () => {
  const run = async (argv: string[], env: Record<string, string | undefined> = {}) => {
    let out = "";
    let err = "";
    const code = await main(argv, {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
      env,
      cwd: root,
    });
    return { code, out, err };
  };

  it("exits 0 on all-pass, 2 on missing, 1 on fail, with --allow-missing exits 0", async () => {
    const g = join(root, "golden");
    const a = join(root, "actual");
    writeSet(g, GOLDEN);
    expect((await run(["--dataset", "demo", "--golden", g, "--actual", g])).code).toBe(0);
    const missing = await run(["--dataset", "demo", "--golden", g, "--actual", "nope"]);
    expect(missing.code).toBe(2);
    expect(missing.out).toContain("missing");
    expect(
      (await run(["--dataset", "demo", "--golden", g, "--actual", "nope", "--allow-missing"])).code,
    ).toBe(0);
    writeSet(a, { ...GOLDEN, "budget.analytics": '{"ratio":0.2,"items":["a","b"]}' });
    const failed = await run(["--dataset", "demo", "--golden", g, "--actual", a]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("$.ratio");
    expect(failed.out).not.toContain("0.2");
  });

  it("resolves relative paths against INIT_CWD and filters checks with a prefix glob", async () => {
    const g = join(root, "golden");
    writeSet(g, GOLDEN);
    const r = await run(
      ["--dataset", "lab", "--golden", "golden", "--actual", "golden", "--check", "core.*"],
      {
        INIT_CWD: root,
      },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 checks: 1 pass");
    expect(
      (await run(["--dataset", "lab", "--golden", g, "--actual", g, "--check", "zzz"])).code,
    ).toBe(70);
  });

  it("validates usage and prints JSON on request", async () => {
    expect((await run([])).code).toBe(64);
    expect((await run(["--dataset", "prod"])).code).toBe(64);
    expect((await run(["--dataset", "demo", "--bogus"])).code).toBe(64);
    expect((await run(["--help"])).code).toBe(0);
    const g = join(root, "golden");
    writeSet(g, GOLDEN);
    const j = await run(["--dataset", "demo", "--golden", g, "--actual", g, "--json"]);
    expect((JSON.parse(j.out) as { counts: { pass: number } }).counts.pass).toBe(2);
  });
});

describe("committed demo goldens (synthetic)", () => {
  const demo = resolve(import.meta.dirname, "..", "..", "..", "parity", "golden-demo");

  it("parse and deep-compare equal to themselves, and to a rewritten copy", () => {
    const deep = runParity({ goldenDir: demo, actualDir: demo, config: noConfig, deep: true });
    expect(deep.counts.fail).toBe(0);
    expect(deep.counts.pass).toBe(deep.checks.length);
    expect(deep.checks.length).toBeGreaterThan(20);

    // Same data, different bytes: key order shuffled by re-serialising through JSON.parse with
    // reversed keys. Numbers survive because the goldens hold no integer above 2^53.
    const copy = join(root, "copy");
    cpSync(demo, copy, { recursive: true });
    for (const { check } of deep.checks) {
      const file = join(copy, `${check}.json`);
      const reversed = JSON.stringify(reverseKeys(JSON.parse(readFileSync(file, "utf8"))), null, 1);
      writeFileSync(file, reversed);
    }
    const report = runParity({ goldenDir: demo, actualDir: copy, config: noConfig });
    expect(report.counts.fail).toBe(0);
  });
});

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .reverse()
        .map(([k, x]) => [k, reverseKeys(x)]),
    );
  }
  return v;
}
