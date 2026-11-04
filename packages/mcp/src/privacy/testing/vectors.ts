/// <reference types="node" />
/**
 * Test helpers for the Python-generated privacy vectors (`parity/python/generators/mcp/privacy_vectors.py`):
 * loading, typed-value decoding (the generator's `enc`), tree decoding and a mismatch collector.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { D, Decimal, floatRepr, formatDateTime, parseDateTime } from "@cashu/domain";
import type { ExprDeps, ExprNode, ExprUnit } from "../exprLiterals.js";
import { Labelled, type LabelledTree, type LeafValue, type Sensitivity } from "../labels.js";
import { NameGuard } from "../names.js";
import { isDateTime } from "../pyText.js";

/** Loads `test/vectors/<name>.jsonl`: the section's fields on the first line, then its rows. */
export function loadVectors<T>(name: string): T {
  const url = new URL(`../../../test/vectors/${name}.jsonl`, import.meta.url);
  const lines = readFileSync(fileURLToPath(url), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const head = JSON.parse(lines[0] as string) as { count: number } & Record<string, unknown>;
  const rows = lines.slice(1).map((line) => JSON.parse(line) as unknown);
  if (rows.length !== head.count)
    throw new Error(`${name}: ${rows.length} rows, the header says ${head.count}`);
  return { ...head, rows } as T;
}

export interface Typed {
  readonly T: "none" | "bool" | "int" | "float" | "dec" | "dt" | "str";
  readonly V?: unknown;
}

function parsePyFloat(text: string): number {
  if (text === "nan") return Number.NaN;
  if (text === "inf") return Number.POSITIVE_INFINITY;
  if (text === "-inf") return Number.NEGATIVE_INFINITY;
  return Number(text);
}

export function decodeValue(t: Typed): LeafValue {
  switch (t.T) {
    case "none":
      return null;
    case "bool":
      return t.V as boolean;
    case "int":
      return BigInt(t.V as string);
    case "float":
      return parsePyFloat(t.V as string);
    case "dec":
      return D(t.V as string);
    case "dt":
      return parseDateTime(t.V as string);
    case "str":
      return t.V as string;
  }
}

export function encodeValue(value: LeafValue): Typed {
  if (value === null) return { T: "none" };
  if (typeof value === "boolean") return { T: "bool", V: value };
  if (typeof value === "bigint") return { T: "int", V: value.toString() };
  if (typeof value === "number") return { T: "float", V: floatRepr(value) };
  if (value instanceof Decimal) return { T: "dec", V: value.toString() };
  if (isDateTime(value)) return { T: "dt", V: formatDateTime(value) };
  return { T: "str", V: value };
}

export type EncodedTree =
  | ({ readonly L: Sensitivity } & Typed)
  | { readonly N: 1 }
  | { readonly D: readonly [string, EncodedTree][] }
  | { readonly A: readonly EncodedTree[] }
  | { readonly R: Typed };

/** A decoded tree; unlabelled leaves (`R`) come back as raw values to test the fail-closed paths. */
export function decodeTree(node: EncodedTree): LabelledTree {
  if ("L" in node) return new Labelled(decodeValue(node), node.L);
  if ("N" in node) return null;
  if ("A" in node) return node.A.map(decodeTree);
  if ("R" in node) return decodeValue(node.R) as unknown as LabelledTree;
  const out: Record<string, LabelledTree> = {};
  for (const [key, value] of node.D) {
    // an own property even for "__proto__" (Python dict keys are plain data)
    Object.defineProperty(out, key, {
      value: decodeTree(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

interface GuardSpec {
  readonly id: number;
  readonly profile_id: number;
  readonly names: readonly string[];
  readonly private_payees: readonly string[];
  readonly strict_aliases: readonly [string, string][];
}

export function guardsById(): Map<number, NameGuard> {
  const file = loadVectors<{ secret_hex: string; guards: GuardSpec[] }>("guards");
  const secret = Uint8Array.from(Buffer.from(file.secret_hex, "hex"));
  return new Map(
    file.guards.map((g) => [
      g.id,
      new NameGuard({
        profileId: g.profile_id,
        names: g.names,
        privatePayees: g.private_payees,
        strictAliases: g.strict_aliases,
        secret,
      }),
    ]),
  );
}

/** Collects mismatches so a failing suite reports the first few instead of stopping at one. */
export class Mismatches {
  readonly items: string[] = [];
  checked = 0;

  check(label: string, actual: unknown, expected: unknown): void {
    this.checked++;
    const a = stable(actual);
    const e = stable(expected);
    if (a !== e) this.items.push(`${label}: got ${a}, want ${e}`);
  }

  report(): string {
    return `${this.items.length} of ${this.checked} mismatched:\n${this.items.slice(0, 25).join("\n")}`;
  }
}

/** JSON text with sorted object keys (the vectors are written with sorted keys); bigints marked. */
function stable(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return `${v}n`;
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

type AstJson =
  | { kind: "number"; value: string; text: string; column: number }
  | { kind: "string"; value: string; column: number }
  | { kind: "boolean"; value: boolean; column: number }
  | { kind: "name"; name: string; column: number }
  | { kind: "call"; name: string; args: AstJson[]; column: number }
  | { kind: "unary"; op: string; operand: AstJson; column: number }
  | { kind: "binary" | "compare"; op: string; left: AstJson; right: AstJson; column: number }
  | { kind: "logical"; op: string; operands: AstJson[]; column: number };

function toNode(a: AstJson): ExprNode {
  switch (a.kind) {
    case "number":
      return { ...a, value: D(a.value) };
    case "call":
      return { ...a, args: a.args.map(toNode) };
    case "unary":
      return { ...a, operand: toNode(a.operand) };
    case "binary":
    case "compare":
      return { ...a, left: toNode(a.left), right: toNode(a.right) };
    case "logical":
      return { ...a, operands: a.operands.map(toNode) };
    default:
      return a;
  }
}

/**
 * Independent Python parser trees and metric units for differential tests of the native adapter:
 * `parse` knows exactly the sources the vectors hold.
 */
export function exprDepsFromVectors(): ExprDeps {
  const file = loadVectors<{
    units: Record<string, ExprUnit | null>;
    rows: { source: string; ast: AstJson | null }[];
  }>("expressions");
  const trees = new Map(file.rows.map((r) => [r.source, r.ast === null ? null : toNode(r.ast)]));
  return {
    parse: (source) => {
      const tree = trees.get(source);
      if (tree === undefined) throw new Error("no tree for this source in the vectors");
      return tree;
    },
    metricUnit: (name) => file.units[name] ?? null,
  };
}

export const BLOCKS_PER_PLANE = 0x10000 / 4096;
export const PLANES = 0x110000 / 0x10000;

/**
 * The per-block digests of one plane (16 blocks of 4096 code points): `fn` of every code point, each
 * followed by NUL, hashed in one update per block (the same digest as one update per code point).
 */
export function planeHashes(fn: (s: string) => string, plane: number): string[] {
  const out: string[] = [];
  for (let b = 0; b < BLOCKS_PER_PLANE; b++) {
    const block = plane * BLOCKS_PER_PLANE + b;
    const parts: string[] = [];
    for (let c = block * 4096; c < (block + 1) * 4096; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      parts.push(fn(String.fromCodePoint(c)), "\0");
    }
    out.push(createHash("sha256").update(parts.join(""), "utf8").digest("hex").slice(0, 16));
  }
  return out;
}

/** `rows` in consecutive slices of at most `size`, each with the index of its first row. */
export function slices<T>(rows: readonly T[], size: number): [number, readonly T[]][] {
  const out: [number, readonly T[]][] = [];
  for (let from = 0; from < rows.length; from += size)
    out.push([from, rows.slice(from, from + size)]);
  return out;
}
