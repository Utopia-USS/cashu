// Pure preparation around existing strategy/version commands. Only owner approval publishes files.

import { loadStrategy, strategyDigest } from "@cashu/domain/investments/strategy";
import { canonicalJson } from "../../canonical.js";
import {
  type ExecutionSnapshot,
  type PreparedEffect,
  proposalExecution,
} from "../../core/proposal-execution.js";
import { type SavedStrategyVersion, saveStrategyVersion } from "../commands/strategy.js";
import { latestStrategyVersion } from "../queries/strategy.js";
import {
  prepareStrategyPublication,
  type StrategyFileImage,
  type StrategyPublicationDeps,
} from "./proposalPublication.js";
import {
  checkResultingStrategy,
  existingProposalRuleIds,
  mergeProposalRule,
  StrategyProposalError,
} from "./proposalRuleText.js";

export type PrepareStrategyApprovalDeps = Omit<StrategyPublicationDeps, "proposalGid"> & {
  readonly proposal: ExecutionSnapshot;
};

export async function prepareStrategyApproval(deps: PrepareStrategyApprovalDeps) {
  const requestedGid = deps.proposal.gid,
    requestedKind = deps.proposal.kind;
  // Snapshot before any await; callers may retain and mutate their display DTO afterwards.
  const fingerprint = canonicalJson(deps.proposal.payload);
  const authority = () => {
    try {
      return (
        deps.isVaultCurrent() &&
        deps.files.vault === deps.store.vault &&
        deps.journal.vault === deps.store.vault &&
        deps.files.isCurrent()
      );
    } catch {
      return false;
    }
  };
  if (!authority())
    throw new StrategyProposalError("unavailable", "strategy file authority unavailable");
  const proposal = proposalExecution(deps.store.read.bind(deps.store), requestedGid);
  if (
    proposal === undefined ||
    proposal.status !== "pending" ||
    proposal.kind !== requestedKind ||
    canonicalJson(proposal.payload) !== fingerprint
  )
    throw new StrategyProposalError("proposal_changed", "the proposal is not current");
  if (proposal.kind !== "strategy" && proposal.kind !== "custom_rule")
    throw new StrategyProposalError("invalid", "not a strategy proposal");
  let rawBase: StrategyFileImage;
  try {
    rawBase = await deps.files.read();
  } catch {
    throw new StrategyProposalError(
      proposal.kind === "strategy" ? "strategy_unreadable" : "strategy_missing",
      "the current strategy files cannot be read",
    );
  }
  if (!authority())
    throw new StrategyProposalError("unavailable", "strategy file authority unavailable");
  // Python Path.read_text normalizes universal newlines before digest/merge/version recording.
  // Keep the raw image separately so publication recovery never loses the owner's original bytes.
  const normalize = (text: string | null) => text?.replace(/\r\n?/gu, "\n") ?? null;
  const base: StrategyFileImage = { yaml: normalize(rawBase.yaml), md: normalize(rawBase.md) };
  const before = base.yaml === null ? null : loadStrategy(base.yaml, base.md);
  const payload = proposal.payload;
  let yamlText: string;
  const mdText = proposal.kind === "strategy" && typeof payload.md === "string" ? payload.md : null;
  let ruleId: string | undefined;
  if (proposal.kind === "strategy") {
    if (strategyDigest(base.yaml ?? "", base.md) !== payload.base_sha256)
      throw new StrategyProposalError(
        "base_changed",
        "the strategy files changed since this proposal was made; ask for a new proposal",
      );
    yamlText = typeof payload.yaml === "string" ? payload.yaml : "";
  } else {
    if (base.yaml === null)
      throw new StrategyProposalError(
        "strategy_missing",
        "the strategy file is missing or cannot be read",
      );
    const entry = payload.rule;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new StrategyProposalError("invalid", "the proposal has no rule");
    const rule = entry as Record<string, unknown>;
    ruleId = typeof rule.id === "string" ? rule.id : undefined;
    if (ruleId !== undefined && existingProposalRuleIds(base.yaml).has(ruleId))
      throw new StrategyProposalError("rule_exists", `the strategy already has a rule ${ruleId}`);
    // Source custom-rule approval intentionally merges into current files, not proposal-time base.
    yamlText = mergeProposalRule(base.yaml, rule);
  }
  const finalMdText = mdText === null ? base.md : mdText;
  const loaded = loadStrategy(yamlText, finalMdText);
  const warnings = checkResultingStrategy(loaded, before, ruleId);
  const publication = await prepareStrategyPublication(
    {
      store: deps.store,
      proposalGid: proposal.gid,
      files: deps.files,
      journal: deps.journal,
      isVaultCurrent: () => deps.isVaultCurrent(),
    },
    rawBase,
    { yaml: yamlText, md: mdText === null ? rawBase.md : mdText },
  );
  if (!authority())
    throw new StrategyProposalError("unavailable", "strategy file authority unavailable");
  const effect: PreparedEffect<SavedStrategyVersion> = {
    proposalGid: proposal.gid,
    kind: proposal.kind,
    recheck(ctx, current) {
      if (ctx.vault !== deps.store.vault || !authority()) return "unavailable";
      if (canonicalJson(current.payload) !== fingerprint) return "proposal_changed";
      if (!publication.isBaseCurrent()) return "base_changed";
      return null;
    },
    apply(ctx) {
      return saveStrategyVersion.run(ctx, { yamlText, mdText: finalMdText });
    },
    approvalResult(result, ctx) {
      const previous = latestStrategyVersion(ctx.read);
      return {
        ...(ruleId === undefined ? {} : { rule_id: ruleId }),
        warnings,
        version: result.recorded ? (previous?.version ?? 0) + 1 : (previous?.version ?? 1),
        state: result.state,
      };
    },
  };
  return { effect, publication, yamlText, mdText: finalMdText, warnings };
}
