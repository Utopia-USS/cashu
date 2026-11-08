// The Strategies tab's documents: main first (listed even when missing), one-file and folder
// strategies from `strategies/`, frontmatter / heading titles, reads limited to the listed files of
// one strategy, symlinks never followed. Translates tests/investments/persistence/test_invp_strategies.py
// (the HTTP routes become the service functions, 404 the refusal; the `brief` field is the surface's,
// S36, checked here with `loadStrategy`). The directory port is an in-memory fake. Synthetic text only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vault } from "../commands/testing/fixtures.js";
import { loadStrategy, type StrategyFileName, type StrategyFilesPort } from "./strategy.js";
import {
  type DirEntry,
  discoverStrategies,
  findStrategy,
  frontmatter,
  MAIN_ID,
  MAX_FILE_BYTES,
  MAX_FILES,
  readStrategyFile,
  type StrategyDocSummary,
  type StrategyDocsDir,
  strategySummary,
} from "./strategy-docs.js";

const STRATEGY_YAML = `version: 1
base_currency: PLN
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
  - id: cash
    match: { asset_class: cash }
allocation:
  targets: { stocks: 0.9, cash: 0.1 }
`;

type Node = { kind: "file"; text: string } | { kind: "dir" } | { kind: "symlink" };

/** An in-memory profile directory keyed by POSIX path ("" = the directory itself). */
class MemoryDir implements StrategyDocsDir {
  readonly nodes = new Map<string, Node>([["", { kind: "dir" }]]);

  private set(path: string, node: Node): this {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.nodes.has(dir)) this.nodes.set(dir, { kind: "dir" });
    }
    this.nodes.set(path, node);
    return this;
  }

  file(path: string, text: string): this {
    return this.set(path, { kind: "file", text });
  }

  dir(path: string): this {
    return this.set(path, { kind: "dir" });
  }

  symlink(path: string): this {
    return this.set(path, { kind: "symlink" });
  }

  async list(path: readonly string[]): Promise<readonly DirEntry[] | null> {
    const key = path.join("/");
    if (this.nodes.get(key)?.kind !== "dir") return null;
    const prefix = key === "" ? "" : `${key}/`;
    const out: DirEntry[] = [];
    for (const [p, node] of this.nodes) {
      if (p === key || !p.startsWith(prefix) || p.slice(prefix.length).includes("/")) continue;
      out.push({
        name: p.slice(prefix.length),
        kind: node.kind,
        size: node.kind === "file" ? new TextEncoder().encode(node.text).length : 0,
      });
    }
    return out;
  }

  async readText(path: readonly string[]): Promise<string | null> {
    const node = this.nodes.get(path.join("/"));
    return node?.kind === "file" ? node.text : null;
  }
}

/** The main strategy files of the same directory, as the strategy service reads them. */
function mainFiles(dir: MemoryDir): StrategyFilesPort {
  return {
    async read(name: StrategyFileName) {
      const node = dir.nodes.get(name);
      return node?.kind === "file" ? node.text : null;
    },
    async write(name: StrategyFileName, text: string) {
      dir.file(name, text);
    },
    async exists(name: StrategyFileName) {
      return dir.nodes.has(name);
    },
  };
}

async function listed(dir: MemoryDir): Promise<Map<string, StrategyDocSummary>> {
  const docs = await discoverStrategies(dir);
  const out = new Map<string, StrategyDocSummary>();
  for (const d of docs) out.set(d.id, await strategySummary(dir, d));
  return out;
}

async function readFile(dir: MemoryDir, id: string, path: string) {
  const doc = await findStrategy(dir, id);
  if (doc === undefined) return { ok: false, reason: "no_strategy" } as const;
  return readStrategyFile(dir, doc, path);
}

describe("test_invp_strategies", () => {
  it("test_main_is_listed_even_without_files", async () => {
    const dir = new MemoryDir();
    const items = await listed(dir);
    expect([...items.keys()]).toEqual([MAIN_ID]);
    const main = items.get(MAIN_ID);
    expect([main?.main, main?.executed, main?.files, main?.title]).toEqual([true, true, [], null]);
    expect((await loadStrategy(vault().store, mainFiles(dir))).state).toBe("missing");
  });

  it("test_main_and_folder_strategies", async () => {
    const dir = new MemoryDir()
      .file("strategy.yaml", STRATEGY_YAML)
      .file("strategy.md", "# Rdzeń ETF\n\nKupuję co miesiąc.\n")
      .dir("strategies/swing/zrodla")
      .file(
        "strategies/swing/README.md",
        "---\ntitle: Swing z sygnałów\nstatus: test\n---\n# Inny\n",
      )
      .file("strategies/swing/rules.yaml", "rules: []\n")
      .file("strategies/swing/zrodla/telegram.md", "Kanał: przykładowy\n")
      .file("strategies/swing/.hidden.md", "x")
      .file("strategies/swing/image.png", "PNG")
      .file("strategies/uznaniowa.md", "Bez nagłówka.\n")
      .file("strategies/uznaniowa.yaml", "review: {}\n")
      .file("strategies/Bad Name.md", "pominięta\n");

    const items = await listed(dir);
    expect([...items.keys()]).toEqual([MAIN_ID, "swing", "uznaniowa"]);
    const main = items.get(MAIN_ID);
    expect([main?.title, main?.mainFile]).toEqual(["Rdzeń ETF", "strategy.md"]);
    expect(main?.files.map((f) => f.path)).toEqual(["strategy.md", "strategy.yaml"]);
    expect((await loadStrategy(vault().store, mainFiles(dir))).state).toBe("valid");

    const swing = items.get("swing");
    expect([swing?.title, swing?.status, swing?.executed]).toEqual([
      "Swing z sygnałów",
      "test",
      false,
    ]);
    expect(swing?.mainFile).toBe("README.md");
    expect(Object.fromEntries(swing?.files.map((f) => [f.path, f.kind]) ?? [])).toEqual({
      "README.md": "md",
      "rules.yaml": "yaml",
      "zrodla/telegram.md": "md",
    });
    const one = items.get("uznaniowa");
    expect(one?.title).toBe("uznaniowa");
    expect(one?.files.map((f) => f.path)).toEqual(["uznaniowa.md", "uznaniowa.yaml"]);
    expect([swing?.root, one?.root, main?.root]).toEqual(["strategies/swing", "strategies", ""]);

    expect(await readFile(dir, "swing", "zrodla/telegram.md")).toEqual({
      ok: true,
      text: "Kanał: przykładowy\n",
    });
  });

  it.each([
    ["swing", "../uznaniowa.md"], // another strategy's file
    ["uznaniowa", "swing/README.md"], // a one-file strategy sees only its own files
    [MAIN_ID, "../../secret.md"],
    [MAIN_ID, "swing.md"],
    ["swing", ".hidden.md"],
    ["nope", "README.md"],
  ])("test_reads_are_limited_to_listed_files %s %s", async (id, path) => {
    const dir = new MemoryDir()
      .file("strategies/swing/README.md", "# Swing\n")
      .file("strategies/swing/.hidden.md", "x")
      .file("strategies/uznaniowa.md", "# U\n");
    expect((await readFile(dir, id, path)).ok).toBe(false);
  });

  it("test_symlinks_are_not_followed", async () => {
    const dir = new MemoryDir().dir("strategies/swing").symlink("strategies/swing/link.md");
    dir.symlink("strategies/linked");
    const items = await listed(dir);
    expect(items.has("linked")).toBe(false);
    expect(items.get("swing")?.files).toEqual([]);
  });

  it("test_frontmatter_ignores_broken_blocks", () => {
    expect(frontmatter("---\ntitle: [\n---\n# A\n")).toEqual({
      fields: {},
      body: "---\ntitle: [\n---\n# A\n",
    });
    expect(frontmatter("---\ntitle: X\nlist: [1]\n---\n# A\n")).toEqual({
      fields: { title: "X" },
      body: "# A\n",
    });
  });
});

describe("strategy documents (store level)", () => {
  it("frontmatter keeps text, numbers and booleans like Python str()", () => {
    const { fields } = frontmatter(
      "---\ntitle: '  T  '\nversion: 2\nratio: 0.5\ndraft: true\nempty: ''\nwhen: 2026-10-31\n---\n",
    );
    expect(fields).toEqual({ title: "T", version: "2", ratio: "0.5", draft: "True" });
  });

  it("a main heading may be indented by blank lines and closed with hashes", async () => {
    const dir = new MemoryDir().file("strategy.md", "Wstęp\n\n#   Plan główny  ##\n");
    expect((await listed(dir)).get(MAIN_ID)?.title).toBe("Plan główny");
  });

  it("a folder of the same id wins over a one-file strategy", async () => {
    const dir = new MemoryDir()
      .file("strategies/swing.md", "# Plik\n")
      .file("strategies/swing/notes.md", "# Folder\n");
    const docs = await discoverStrategies(dir);
    expect(docs.map((d) => [d.id, d.single, d.files])).toEqual([
      [MAIN_ID, null, []],
      ["swing", null, ["notes.md"]],
    ]);
  });

  it("walk limits: depth and file count", async () => {
    const dir = new MemoryDir()
      .file("strategies/deep/a/b/c.md", "x")
      .file("strategies/deep/a/b/c/too-deep.md", "x")
      .file("strategies/deep/a/d.md", "x");
    for (let i = 0; i < MAX_FILES + 5; i++)
      dir.file(`strategies/many/f${String(i).padStart(3, "0")}.md`, "x");
    const docs = await discoverStrategies(dir);
    expect(docs.find((d) => d.id === "deep")?.files).toEqual(["a/b/c.md", "a/d.md"]);
    expect(docs.find((d) => d.id === "many")?.files).toHaveLength(MAX_FILES);
  });

  it("a listed file swapped for a symlink, or too large, is not read", async () => {
    const dir = new MemoryDir().file("strategies/swing/README.md", "# Swing\n");
    const doc = await findStrategy(dir, "swing");
    if (doc === undefined) throw new Error("no strategy");
    dir.symlink("strategies/swing/README.md");
    expect(await readStrategyFile(dir, doc, "README.md")).toEqual({ ok: false, reason: "no_file" });
    dir.file("strategies/swing/README.md", "x".repeat(MAX_FILE_BYTES + 1));
    expect(await readStrategyFile(dir, doc, "README.md")).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});

describe("strategy-frontmatter vectors (the retired Python vectors_yaml_safe_load.py)", () => {
  it("equals Python strategy_docs.frontmatter on every case", () => {
    const url = new URL("../../../test/vectors/strategy-frontmatter.jsonl", import.meta.url);
    const lines = readFileSync(url, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    const rows = lines.slice(1).map((line) => JSON.parse(line) as [string, object, string]);
    expect(rows.length).toBeGreaterThan(0);
    for (const [text, fields, body] of rows) {
      expect(frontmatter(text), JSON.stringify(text)).toEqual({ fields, body });
    }
  });
});
