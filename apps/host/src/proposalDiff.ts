import { pySplitlines } from "@cashu/domain";

type Block = { i: number; j: number; n: number };
type Op = {
  tag: "equal" | "replace" | "delete" | "insert";
  a: number;
  b: number;
  c: number;
  d: number;
};

/** Source-compatible SequenceMatcher blocks for bounded owner-visible proposal text. */
function matchingBlocks(a: readonly string[], b: readonly string[]): Block[] {
  const index = new Map<string, number[]>();
  b.forEach((line, j) => {
    index.set(line, [...(index.get(line) ?? []), j]);
  });
  if (b.length >= 200)
    for (const [line, at] of index)
      if (at.length > Math.floor(b.length / 100) + 1) index.delete(line);
  const found: Block[] = [];
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  for (let range = queue.pop(); range !== undefined; range = queue.pop()) {
    const [alo, ahi, blo, bhi] = range;
    let i0 = alo;
    let j0 = blo;
    let size = 0;
    let prior = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of index.get(a[i] ?? "") ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const n = (prior.get(j - 1) ?? 0) + 1;
        next.set(j, n);
        if (n > size) {
          i0 = i - n + 1;
          j0 = j - n + 1;
          size = n;
        }
      }
      prior = next;
    }
    while (i0 > alo && j0 > blo && a[i0 - 1] === b[j0 - 1]) {
      i0--;
      j0--;
      size++;
    }
    while (i0 + size < ahi && j0 + size < bhi && a[i0 + size] === b[j0 + size]) size++;
    if (size === 0) continue;
    found.push({ i: i0, j: j0, n: size });
    if (alo < i0 && blo < j0) queue.push([alo, i0, blo, j0]);
    if (i0 + size < ahi && j0 + size < bhi) queue.push([i0 + size, ahi, j0 + size, bhi]);
  }
  found.sort((x, y) => x.i - y.i || x.j - y.j);
  const merged: Block[] = [];
  for (const block of [...found, { i: a.length, j: b.length, n: 0 }]) {
    const last = merged.at(-1);
    if (last && last.i + last.n === block.i && last.j + last.n === block.j) last.n += block.n;
    else merged.push({ ...block });
  }
  return merged;
}

function operations(a: readonly string[], b: readonly string[]): Op[] {
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  for (const block of matchingBlocks(a, b)) {
    if (i < block.i || j < block.j)
      out.push({
        tag: i < block.i ? (j < block.j ? "replace" : "delete") : "insert",
        a: i,
        b: block.i,
        c: j,
        d: block.j,
      });
    if (block.n)
      out.push({
        tag: "equal",
        a: block.i,
        b: block.i + block.n,
        c: block.j,
        d: block.j + block.n,
      });
    i = block.i + block.n;
    j = block.j + block.n;
  }
  return out;
}

function range(start: number, stop: number): string {
  const length = stop - start;
  return length === 1 ? String(start + 1) : `${length === 0 ? start : start + 1},${length}`;
}

/** Python difflib.unified_diff with three context lines and no line terminator. */
export function proposalUnifiedDiff(
  old: string | null,
  next: string | null,
  name: string,
): string | null {
  const a = pySplitlines(old ?? "");
  const b = pySplitlines(next ?? "");
  if (a.length + b.length > 20_000) return null;
  const ops = operations(a, b);
  if (ops.every((op) => op.tag === "equal")) return "";
  const context = 3;
  const first = ops[0];
  if (first?.tag === "equal")
    ops[0] = {
      ...first,
      a: Math.max(first.a, first.b - context),
      c: Math.max(first.c, first.d - context),
    };
  const lastOp = ops.at(-1);
  if (lastOp?.tag === "equal")
    ops[ops.length - 1] = {
      ...lastOp,
      b: Math.min(lastOp.b, lastOp.a + context),
      d: Math.min(lastOp.d, lastOp.c + context),
    };
  const groups: Op[][] = [];
  let group: Op[] = [];
  for (let op of ops) {
    if (op.tag === "equal" && op.b - op.a > context * 2) {
      const before = { ...op, b: op.a + context, d: op.c + context };
      const after = { ...op, a: op.b - context, c: op.d - context };
      if (group.length) {
        group.push(before);
        groups.push(group);
        group = [];
      }
      op = after;
    }
    group.push(op);
  }
  if (group.length && !(group.length === 1 && group[0]?.tag === "equal")) groups.push(group);
  const lines = [`--- ${name} (current)`, `+++ ${name} (proposed)`];
  for (const chunk of groups) {
    const first = chunk[0];
    const last = chunk.at(-1);
    if (!first || !last) continue;
    lines.push(`@@ -${range(first.a, last.b)} +${range(first.c, last.d)} @@`);
    for (const op of chunk) {
      if (op.tag === "equal" || op.tag === "replace" || op.tag === "delete")
        for (const line of a.slice(op.a, op.b))
          lines.push(`${op.tag === "equal" ? " " : "-"}${line}`);
      if (op.tag === "replace" || op.tag === "insert")
        for (const line of b.slice(op.c, op.d)) lines.push(`+${line}`);
    }
  }
  return lines.join("\n");
}
