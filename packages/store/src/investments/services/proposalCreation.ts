/** Source proposal preparation. Approval/publication remain separate owner actions. */
import { pySplitlines, pyStrip } from "@cashu/domain";
import { expr } from "@cashu/domain/investments/rules";
import {
  loadStrategy,
  type StrategyIssue,
  strategyDigest,
} from "@cashu/domain/investments/strategy";
import { z } from "zod";
import { defineCommand, refuse } from "../../command.js";
import { createProposal } from "../../core/proposal-commands.js";
import type { StrategyFileImage } from "./proposalPublication.js";
import {
  checkResultingStrategy,
  existingProposalRuleIds,
  mergeProposalRule,
  proposalRuleEntry,
  StrategyProposalError,
} from "./proposalRuleText.js";

/** Python unified_diff(n=0) uses SequenceMatcher on lines, including autojunk and tie order. */
export function proposalDiffStats(old: string | null, next: string | null) {
  const a = pySplitlines(old ?? ""),
    b = pySplitlines(next ?? ""),
    index = new Map<string, number[]>();
  b.forEach((line, j) => {
    index.set(line, [...(index.get(line) ?? []), j]);
  });
  if (b.length >= 200)
    for (const [line, indices] of index)
      if (indices.length > Math.floor(b.length / 100) + 1) index.delete(line);
  const blocks: { i: number; j: number; n: number }[] = [],
    queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  for (let range = queue.pop(); range !== undefined; range = queue.pop()) {
    const [alo, ahi, blo, bhi] = range;
    let bi = alo,
      bj = blo,
      size = 0,
      previous = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const current = new Map<number, number>();
      for (const j of index.get(a[i] ?? "") ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const n = (previous.get(j - 1) ?? 0) + 1;
        current.set(j, n);
        if (n > size) {
          bi = i - n + 1;
          bj = j - n + 1;
          size = n;
        }
      }
      previous = current;
    }
    while (bi > alo && bj > blo && a[bi - 1] === b[bj - 1]) {
      bi--;
      bj--;
      size++;
    }
    while (bi + size < ahi && bj + size < bhi && a[bi + size] === b[bj + size]) size++;
    if (!size) continue;
    blocks.push({ i: bi, j: bj, n: size });
    if (alo < bi && blo < bj) queue.push([alo, bi, blo, bj]);
    if (bi + size < ahi && bj + size < bhi) queue.push([bi + size, ahi, bj + size, bhi]);
  }
  const keptA = new Set<number>(),
    keptB = new Set<number>();
  for (const block of blocks)
    for (let k = 0; k < block.n; k++) {
      keptA.add(block.i + k);
      keptB.add(block.j + k);
    }
  // Source ignores every unified output line starting ---/+++, including a changed data line.
  return {
    lines_added: b.filter((line, i) => !keptB.has(i) && !line.startsWith("++")).length,
    lines_removed: a.filter((line, i) => !keptA.has(i) && !line.startsWith("--")).length,
  };
}
export function prepareStrategyCreation(base: StrategyFileImage, yaml: string, md: string | null) {
  if (!pyStrip(yaml)) throw new StrategyProposalError("invalid", "yaml is empty");
  const result = loadStrategy(yaml, md),
    before = base.yaml === null ? null : loadStrategy(base.yaml, base.md);
  let error: StrategyProposalError | undefined;
  let warnings: ReturnType<typeof checkResultingStrategy> = [];
  try {
    warnings = checkResultingStrategy(result, before);
  } catch (e) {
    if (!(e instanceof StrategyProposalError)) throw e;
    error = e;
  }
  return {
    result,
    warnings,
    error,
    yamlDiff: proposalDiffStats(base.yaml, yaml),
    mdDiff: md === null ? null : proposalDiffStats(base.md, md),
  };
}
export function prepareRuleCreation(
  base: StrategyFileImage,
  text: string,
  params: Readonly<Record<string, unknown>>,
) {
  if (base.yaml === null)
    throw new StrategyProposalError(
      "no_strategy",
      "the profile has no strategy yet: propose_strategy first (or the owner runs strategy init)",
    );
  const before = loadStrategy(base.yaml, base.md);
  if (before.config === null && before.partial === null)
    throw new StrategyProposalError(
      "invalid",
      "the current strategy has errors; fix them (strategy_status) before adding rules",
    );
  const ids = existingProposalRuleIds(base.yaml),
    { entry, expression } = proposalRuleEntry(text, params, ids);
  const merged = mergeProposalRule(base.yaml, entry);
  let own: Pick<StrategyIssue, "severity" | "path" | "message" | "line" | "column">[] = [];
  if (expression !== null) {
    const scope = (entry.params as Record<string, unknown> | undefined)?.scope ?? "portfolio";
    try {
      expr.compileExpression(expression, String(scope));
    } catch (e) {
      if (e instanceof expr.ExpressionError)
        own = [
          {
            severity: "error",
            path: "params.when",
            message: e.message,
            line: null,
            column: e.column,
          },
        ];
      else if (e instanceof RangeError || e instanceof TypeError)
        own = [
          {
            severity: "error",
            path: "params.scope",
            message: "scope must be portfolio, instrument or bucket",
            line: null,
            column: null,
          },
        ];
      else throw e;
    }
  }
  const result = own.length ? null : loadStrategy(merged, base.md),
    prefix = `rules[${ids.size}]`;
  if (result !== null)
    own = result.issues.filter(
      (i) =>
        i.path === prefix || i.path.startsWith(`${prefix}.`) || i.path.startsWith(`${prefix}[`),
    );
  const config = result?.config ?? result?.partial ?? null;
  const spec = config?.rules.find((r) => r.id === entry.id) ?? null;
  return { entry, result, own, config, spec };
}
export interface ProposalCreationFiles {
  readonly vault: string;
  /** Checked, bounded synchronous read of actual profile files, never a stored-version substitute. */
  read(): StrategyFileImage;
  isCurrent(): boolean;
}
/** Re-read the real base immediately before buffering creation; never substitute stored versions. */
export function createInvestmentProposal(files: ProposalCreationFiles, base: StrategyFileImage) {
  const digest = strategyDigest(base.yaml ?? "", base.md);
  return defineCommand({
    id: "investments.mcp.createProposal",
    input: z.object({
      kind: z.enum(["strategy", "custom_rule"]),
      summary: z.string(),
      reason: z.string().nullable(),
      payload: z.record(z.string(), z.unknown()),
    }),
    run(ctx, input) {
      if (ctx.vault !== files.vault || !files.isCurrent())
        return refuse("file_authority_unavailable");
      const current = files.read();
      if (!files.isCurrent() || strategyDigest(current.yaml ?? "", current.md) !== digest)
        return refuse("base_changed");
      return createProposal.run(ctx, { ...input, source: "agent" });
    },
  });
}
