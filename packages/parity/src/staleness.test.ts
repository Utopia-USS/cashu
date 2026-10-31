/// <reference types="node" />
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { sha256Hex } from "./json.ts";
import { indexEntry, updateTsIndex } from "./producers/tsIndex.ts";
import { checkStaleness, recordedState } from "./staleness.ts";

const HEAD = "1111111111111111111111111111111111111111";
const OLD = "2222222222222222222222222222222222222222";
const TEXT = '{"total":"1.00"}\n';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cashu-parity-stale-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A golden-style dir (golden.py, the bridges): one check, `commit` / `dirty` at the top. */
function pySet(dir: string, meta: Record<string, unknown>, check = "core.networth") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${check}.json`), TEXT);
  const index = { format: 1, ...meta, checks: [{ check, rows: 1, sha256: sha256Hex(TEXT) }] };
  writeFileSync(join(dir, "index.json"), JSON.stringify(index));
}

/** A TS output dir as `pnpm parity:produce` writes it, reading `inputs` (name -> dir). */
function tsSet(dir: string, commit: string | null, inputs: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "core.networth.json"), TEXT);
  const tree = commit === null ? null : { commit, dirty: false };
  updateTsIndex(dir, "lab", [indexEntry("core.networth", 1, sha256Hex(TEXT), tree, inputs)], []);
}

async function run(argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(["--dataset", "lab", ...argv], {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    env: { CASHU_LAB_DIR: join(root, "lab") },
    cwd: root,
    tree: () => ({ commit: HEAD, dirty: false }),
  });
  return { code, out, err };
}

describe("pnpm parity staleness guard", () => {
  it("passes when golden, TS output and its inputs all record HEAD", async () => {
    const golden = join(root, "golden");
    const bridge = join(root, "bridge");
    pySet(golden, { commit: HEAD, dirty: false });
    pySet(bridge, { commit: HEAD, dirty: false }, "mcp.guard_sources");
    tsSet(join(root, "ts"), HEAD, { "bridge-mcp": bridge });
    const r = await run(["--golden", golden, "--actual", join(root, "ts")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 checks: 1 pass");
    expect(r.out + r.err).not.toContain("stale");
  });

  it("refuses a golden dir whose index records no commit, naming the dir", async () => {
    const golden = join(root, "golden");
    pySet(golden, {});
    tsSet(join(root, "ts"), HEAD);
    const r = await run(["--golden", golden, "--actual", join(root, "ts")]);
    expect(r.code).toBe(70);
    expect(r.out).toBe("");
    expect(r.err).toContain("parity refused");
    expect(r.err).toContain(`golden ${golden}: index.json records no source commit`);
  });

  it("refuses a golden, a TS output or a bridge of another commit, naming the recorded commit", async () => {
    const golden = join(root, "golden");
    const bridge = join(root, "bridge");
    pySet(golden, { commit: OLD });
    pySet(bridge, { commit: HEAD }, "mcp.guard_sources");
    tsSet(join(root, "ts"), HEAD, { "bridge-mcp": bridge });
    let r = await run(["--golden", golden, "--actual", join(root, "ts")]);
    expect(r.code).toBe(70);
    expect(r.err).toContain(`golden ${golden}: recorded commit 2222222, not HEAD`);

    pySet(golden, { commit: HEAD });
    tsSet(join(root, "ts"), OLD, { "bridge-mcp": bridge });
    r = await run(["--golden", golden, "--actual", join(root, "ts")]);
    expect(r.code).toBe(70);
    expect(r.err).toContain(`ts-out ${join(root, "ts")} (core.networth): recorded commit 2222222`);

    // The bridge was at another commit when the TS output read it, and still is.
    pySet(bridge, { commit: OLD }, "mcp.guard_sources");
    tsSet(join(root, "ts"), HEAD, { "bridge-mcp": bridge });
    r = await run(["--golden", golden, "--actual", join(root, "ts")]);
    expect(r.code).toBe(70);
    expect(r.err).toContain(`bridge-mcp ${bridge} (core.networth): recorded commit 2222222`);

    // Regenerated at HEAD after the TS output read it: the TS output is still stale.
    pySet(bridge, { commit: HEAD }, "mcp.guard_sources");
    expect((await run(["--golden", golden, "--actual", join(root, "ts")])).code).toBe(70);
  });

  it("refuses a TS output without an index (files of an older producer)", async () => {
    const golden = join(root, "golden");
    pySet(golden, { commit: HEAD });
    mkdirSync(join(root, "ts"));
    writeFileSync(join(root, "ts", "core.networth.json"), TEXT);
    const r = await run(["--golden", golden, "--actual", join(root, "ts")]);
    expect(r.code).toBe(70);
    expect(r.err).toContain("(core.networth): index.json records no source commit");
  });

  it("--allow-stale compares anyway and says so loudly, before and after the table", async () => {
    const golden = join(root, "golden");
    pySet(golden, {});
    tsSet(join(root, "ts"), OLD);
    const r = await run(["--golden", golden, "--actual", join(root, "ts"), "--allow-stale"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 checks: 1 pass");
    const banners = r.out.split("--allow-stale: comparing 2 STALE input(s)").length - 1;
    expect(banners).toBe(2);
    const json = await run([
      "--golden",
      golden,
      "--actual",
      join(root, "ts"),
      "--allow-stale",
      "--json",
    ]);
    expect(json.err).toContain("STALE");
    const parsed = JSON.parse(json.out) as { staleness: { allowed: boolean; stale: unknown[] } };
    expect(parsed.staleness.allowed).toBe(true);
    expect(parsed.staleness.stale).toHaveLength(2);
  });

  it("refuses when there is no commit under test", async () => {
    const golden = join(root, "golden");
    pySet(golden, { commit: HEAD });
    const r = await main(["--dataset", "lab", "--golden", golden, "--actual", golden], {
      out: () => {},
      err: () => {},
      env: {},
      cwd: root,
      tree: () => null,
    });
    expect(r).toBe(70);
  });
});

describe("checkStaleness", () => {
  const base = (over: Partial<Parameters<typeof checkStaleness>[0]>) =>
    checkStaleness({
      dataset: "demo",
      goldenDir: join(root, "repo", "parity", "golden-demo"),
      actualDir: join(root, "nope"),
      checks: ["core.networth"],
      head: { commit: HEAD, dirty: false },
      repoRoot: join(root, "repo"),
      labDir: join(root, "lab"),
      ...over,
    });

  it("cross-checks committed goldens against the shared goldens at HEAD", () => {
    const committed = join(root, "repo", "parity", "golden-demo");
    pySet(committed, { commit: OLD }); // committed goldens never record HEAD
    const shared = join(root, "lab", "parity", "out", "demo");

    let s = base({});
    expect(s.stale).toEqual([]);
    expect(s.notes.join()).toContain("not cross-checked");

    pySet(shared, { commit: HEAD });
    s = base({});
    expect(s.stale).toEqual([]);
    expect(s.notes).toEqual([]);

    writeFileSync(join(shared, "core.networth.json"), '{"total":"2.00"}\n');
    const index = JSON.parse(readFileSync(join(shared, "index.json"), "utf8"));
    index.checks[0].sha256 = sha256Hex('{"total":"2.00"}\n');
    writeFileSync(join(shared, "index.json"), JSON.stringify(index));
    s = base({});
    expect(s.stale.map((x) => [x.role, x.check, x.reason])).toEqual([
      ["golden", "core.networth", "committed-differs"],
    ]);
  });

  it("reads the older '<sha>-dirty' commit form and notes dirty producers", () => {
    expect(recordedState({ commit: `${HEAD}-dirty` })).toEqual({ commit: HEAD, dirty: true });
    expect(recordedState({ commit: HEAD, dirty: true })).toEqual({ commit: HEAD, dirty: true });
    expect(recordedState({ commit: "unknown" })).toEqual({ commit: null, dirty: false });
    const golden = join(root, "golden");
    pySet(golden, { commit: `${HEAD}-dirty` });
    const s = base({ goldenDir: golden });
    expect(s.stale).toEqual([]);
    expect(s.notes.join()).toContain("dirty tree");
  });
});

describe("TS output index", () => {
  it("records commit, dirty and input commits per check, keeps other checks, drops failed ones", () => {
    const ts = join(root, "ts");
    const bridge = join(root, "bridge");
    pySet(bridge, { commit: OLD, dirty: true }, "mcp.guard_sources");
    const sha = sha256Hex(TEXT);
    const tree = { commit: HEAD, dirty: true };
    mkdirSync(ts);
    writeFileSync(join(ts, "a.json"), TEXT);
    writeFileSync(join(ts, "b.json"), TEXT);
    updateTsIndex(
      ts,
      "lab",
      [indexEntry("a", 1, sha, tree, {}), indexEntry("b", 1, sha, tree, {})],
      [],
    );
    updateTsIndex(ts, "lab", [indexEntry("a", 2, sha, tree, { "bridge-mcp": bridge })], ["b"]);
    const index = JSON.parse(readFileSync(join(ts, "index.json"), "utf8"));
    expect(index.checks).toEqual([
      {
        check: "a",
        rows: 2,
        sha256: sha,
        commit: HEAD,
        dirty: true,
        inputs: { "bridge-mcp": { dir: bridge, commit: OLD, dirty: true } },
      },
    ]);
    expect(() => readFileSync(join(ts, "b.json"))).toThrow();
  });
});
