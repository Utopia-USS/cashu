// MCP propose_account_removal: the agent proposes hiding a bank account the owner no longer uses;
// nothing changes until the owner approves it in the app. Accounts are named by their generated
// labels only (`networth_breakdown` lists them), never by numbers or names.
import { pyCasefold, pyStrip } from "@cashu/domain";
import { isRemovableBankAccount, proposeAccountRemoval } from "@cashu/store";
import { accountByGid, mcpAccounts } from "@cashu/store/core";
import * as L from "../privacy/labels.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import * as F from "./researchLabels.js";

const NOT_BANK = "only bank accounts (checking, savings, credit card) can be removed";
const REFUSALS: Readonly<Record<string, readonly [string, string]>> = {
  already_removed: ["the account is already removed from view", "invalid"],
  already_proposed: ["a removal of this account already waits for the owner's approval", "conflict"],
  no_bank_account: [NOT_BANK, "invalid"],
};

export async function proposeAccountRemovalTool(
  ctx: ToolContext<NativeToolStore>,
  args: ToolArgs,
): Promise<L.LabelledTree> {
  const wanted = pyCasefold(typeof args.account === "string" ? pyStrip(args.account) : "");
  const matches = mcpAccounts(ctx.store.read).filter(
    (row) => wanted !== "" && pyCasefold(ctx.accountLabels.get(row.id) ?? "") === wanted,
  );
  const row = matches.length === 1 ? matches[0] : undefined;
  const label = row ? ctx.accountLabels.get(row.id) : undefined;
  const account = row ? accountByGid(ctx.store.read, row.gid) : undefined;
  if (!row || !label || !account || account.removed)
    throw new ToolError(
      "no such visible account; use an account label from networth_breakdown",
      "not_found",
    );
  if (!isRemovableBankAccount(account)) throw new ToolError(NOT_BANK, "invalid");
  const reason = typeof args.reason === "string" ? pyStrip(args.reason) || null : null;
  const result = await ctx.store.run(proposeAccountRemoval, { account: row.gid, label, reason });
  if (!result.ok) {
    const [message, code] = REFUSALS[result.reason] ?? ["account removal refused", "invalid"];
    throw new ToolError(message, code);
  }
  return {
    account: L.account(label),
    stored: L.flag(true),
    proposal_id: F.ref("proposal", result.value.proposalGid),
    note: L.fixedText(
      "stored as a proposal; the owner approves it in the app (Przegląd > Konta). Approving hides the account from the overview, account lists and net worth, stops its imports and takes its transactions out of the budget; the owner can restore it with its history.",
    ),
  };
}
