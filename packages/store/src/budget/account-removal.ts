// Removing a bank account from view (archive): the account and its history stay in the vault and the
// removal is reversible. `account.removed` (SOFT, events.md 8.2) already hides an account from the
// overview, the account lists, net worth and every import route (Open Banking and statements refuse
// a removed account, also matched by IBAN, so a re-link never re-creates or silently restores it);
// its transactions leave the budget (`budgetBook` reads only live accounts' rows) and its IBAN stays
// an own IBAN for transfer matching; `account.restored` brings both back.
// These commands open that removal to bank accounts (asset accounts use `assets.*OverviewAsset`,
// loans and brokerage accounts keep their own flows) and let the agent propose it for the owner's
// approval (proposal kind `account_removal`).
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../command.js";
import { removeAccount, restoreAccount } from "../core/commands.js";
import { createProposal } from "../core/proposal-commands.js";
import type { ExecutionSnapshot, PreparedEffect } from "../core/proposal-execution.js";
import { type AccountView, accountByGid } from "../core/queries.js";
import { gid } from "../events/v1/primitives.js";
import type { Read } from "../query.js";
import { STATEMENT_ACCOUNT_TYPES } from "./statement-import.js";

/** A bank account the budget owns (checking, savings, credit); the cash pools and others are not. */
export function isRemovableBankAccount(account: AccountView | undefined): account is AccountView {
  return (
    account !== undefined && (STATEMENT_ACCOUNT_TYPES as readonly string[]).includes(account.type)
  );
}

const accountRef = z.object({ account: gid });

/** Hide a bank account (idempotent); `restoreBankAccount` brings it back. */
export const removeBankAccount = defineCommand({
  id: "budget.removeBankAccount",
  input: accountRef,
  run(ctx, input) {
    if (!isRemovableBankAccount(accountByGid(ctx.read, input.account)))
      return refuse("no_bank_account");
    return removeAccount.run(ctx, input);
  },
});

/** Bring a removed bank account back (idempotent). */
export const restoreBankAccount = defineCommand({
  id: "budget.restoreBankAccount",
  input: accountRef,
  run(ctx, input) {
    if (!isRemovableBankAccount(accountByGid(ctx.read, input.account)))
      return refuse("no_bank_account");
    return restoreAccount.run(ctx, input);
  },
});

/** The pending removal proposal of `account`, if any. */
function pendingRemoval(read: Read, account: string): string | undefined {
  return read<{ gid: string }>(
    `SELECT gid FROM proposals WHERE kind = 'account_removal' AND status = 'pending'
       AND json_valid(payload) AND json_extract(payload, '$.account') = ? LIMIT 1`,
    account,
  )[0]?.gid;
}

/**
 * The agent's proposal to remove a visible bank account (MCP `propose_account_removal`); the owner
 * approves it in the app. `label` is the account's generated MCP label, the only name the agent
 * knows; the app shows the account's own name. One pending proposal per account.
 */
export const proposeAccountRemoval = defineCommand({
  id: "budget.proposeAccountRemoval",
  input: z.object({
    account: gid,
    label: z.string().min(1).max(200),
    reason: z.string().max(1000).nullable(),
  }),
  run(ctx, input) {
    const account = accountByGid(ctx.read, input.account);
    if (!isRemovableBankAccount(account)) return refuse("no_bank_account");
    if (account.removed) return refuse("already_removed");
    if (pendingRemoval(ctx.read, account.gid) !== undefined) return refuse("already_proposed");
    return createProposal.run(ctx, {
      kind: "account_removal",
      summary: `Remove account ${input.label} from view`,
      summaryParams: { account: input.label },
      reason: input.reason,
      payload: { account: account.gid },
      source: "agent",
    });
  },
});

const payloadSchema = z.looseObject({ account: gid });

/**
 * The approval effect of an `account_removal` proposal: the account must still be a visible bank
 * account and the proposal unchanged; approving removes it under the approval's causal edge (a
 * revoked approval brings it back).
 */
export function prepareAccountRemoval(
  read: Read,
  snapshot: ExecutionSnapshot,
): ReturnType<typeof ok<PreparedEffect<null>>> | ReturnType<typeof refuse> {
  if (snapshot.kind !== "account_removal") return refuse("wrong_kind");
  if (snapshot.status !== "pending") return refuse("not_pending");
  const parsed = payloadSchema.safeParse(snapshot.payload);
  if (!parsed.success) return refuse("invalid_payload");
  const account = parsed.data.account;
  const visible = (r: Read) => {
    const a = accountByGid(r, account);
    return isRemovableBankAccount(a) && !a.removed;
  };
  if (!visible(read)) return refuse("account_unavailable");
  const fingerprint = JSON.stringify(snapshot.payload);
  return ok({
    proposalGid: snapshot.gid,
    kind: "account_removal" as const,
    recheck(ctx: CommandContext, fresh: ExecutionSnapshot) {
      if (fresh.gid !== snapshot.gid || JSON.stringify(fresh.payload) !== fingerprint)
        return "proposal_changed";
      return visible(ctx.read) ? null : "account_unavailable";
    },
    apply(ctx: CommandContext) {
      return removeBankAccount.run(ctx, { account });
    },
    approvalResult: () => ({ removed: account }),
  });
}
