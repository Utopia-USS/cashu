// `safeLoadYaml` against Python `yaml.safe_load` (vectors from the retired Python vectors_yaml_safe_load.py,
// yaml-safe-load: frontmatter-like documents, scalars of every core tag, key folding, merge keys,
// errors) and the lenient `toPlain` the strategy loader uses. Synthetic text only.
import { describe, expect, it } from "vitest";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import { composeYaml, type YamlNode } from "./index.js";
import { PyDate, PyDateTime, type PyPlain, pyStr } from "./plain.js";
import { plainMap, safeLoadYaml, toPlain } from "./plainTree.js";

/** The generator's `encode`. */
function encode(value: PyPlain): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return { int: value.toString() };
  if (typeof value === "number") return { float: pyStr(value) };
  if (value instanceof PyDateTime) return { datetime: value.isoformat(" ") };
  if (value instanceof PyDate) return { date: value.isoformat() };
  if (Array.isArray(value)) return value.map(encode);
  if (value instanceof Map) return { map: [...value].map(([k, v]) => [k, encode(v)]) };
  throw new Error("unexpected value");
}

function node(text: string): YamlNode {
  const composed = composeYaml(text);
  if (!composed.ok || composed.node === null) throw new Error("test document must compose");
  return composed.node;
}

describe("yaml-safe-load vectors", () => {
  it("equals yaml.safe_load on every document (any Python exception is ok: false)", () => {
    const m = new Mismatches();
    for (const [text, want] of loadVectors("yaml-safe-load").rows as [
      string,
      { value?: unknown; error?: unknown },
    ][]) {
      const got = safeLoadYaml(text);
      if ("error" in want) m.check(JSON.stringify(text), got.ok, false);
      else m.check(JSON.stringify(text), got.ok ? { value: encode(got.value) } : got, want);
    }
    expectAll(m);
  });
});

describe("safeLoadYaml", () => {
  it("returns the compose error of a broken document", () => {
    const out = safeLoadYaml("a: [unclosed\n");
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error?.kind).toBe("marked");
  });

  it("refuses the tags the port has no value for and a collection inside itself", () => {
    expect(safeLoadYaml("a: !!set {x: null}\n")).toEqual({ ok: false, error: null });
    expect(safeLoadYaml("a: !!binary aGk=\n")).toEqual({ ok: false, error: null });
    expect(safeLoadYaml("a: &a [*a]\n")).toEqual({ ok: false, error: null });
  });

  it("is null for an empty document", () => {
    expect(safeLoadYaml("# nothing\n")).toEqual({ ok: true, value: null });
  });
});

describe("toPlain (strategy yaml_tree.to_plain)", () => {
  it("keeps key text and a scalar that does not construct as text", () => {
    const root = node("1: x\nyes: !!int ''\nwhen: 2026-11-01\n");
    if (root.kind !== "mapping") throw new Error("mapping expected");
    const plain = plainMap(root);
    expect([...plain.keys()]).toEqual(["1", "yes", "when"]);
    expect(plain.get("yes")).toBe("");
    expect(plain.get("when")).toBeInstanceOf(PyDate);
    expect(toPlain(node("[1, a]\n"))).toEqual([1n, "a"]);
  });
});
