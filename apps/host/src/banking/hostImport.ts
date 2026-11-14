import { randomBytes } from "node:crypto";
import { ibanKey, normalizeIban } from "@cashu/domain";
import { builtinRegistry } from "@cashu/domain/core";
import { type CommandContext, defineCommand, importStatement, refuse } from "@cashu/store";
import {
  accountByExternalKey,
  accountByGid,
  accountByIbanKey,
  enabledModuleIds,
} from "@cashu/store/core";
import type { Read } from "@cashu/store/query";
import { z } from "zod";
import { lookupHostVaultCommandStatus, runHostVaultCommand } from "../commands.js";
import type { OpenVault } from "../stores.js";
import type { BankingAuthority, BankingImportPort } from "./service.js";

/** Production budget command adapter. The network phase never holds a store transaction. */
export function createVaultBankingImportPort(
  vault: OpenVault,
  authority: BankingAuthority,
): BankingImportPort {
  const registry = builtinRegistry();
  const usable = (account: { type: string; removed: boolean }) =>
    !account.removed && registry.accountTypes.get(account.type).module === "budget";
  const live = () =>
    vault.mode === "native" &&
    vault.id === authority.profileId &&
    authority.isCurrent() &&
    authority.isHolder() &&
    vault.native.canRunSideEffects();
  return {
    checkAttempt(key) {
      if (!/^[a-f0-9]{32}$/.test(key) || !live()) return "outcome_unknown";
      return lookupHostVaultCommandStatus(vault, "banking.importAccount", key);
    },
    async unresolvedAttempts() {
      if (!live() || vault.mode !== "native") return [];
      const records = await vault.native.attempts.unresolved(vault.id);
      if (!live()) return [];
      return records
        .filter(
          (item) => item.commandId === "banking.importAccount" && /^[a-f0-9]{32}$/.test(item.key),
        )
        .slice(0, 100)
        .map((item) => ({ key: item.key, command: "banking.importAccount" as const }));
    },
    async findAccount(profileId, bank, uid, iban) {
      if (profileId !== vault.id || !live()) return null;
      const read: Read = (sql, ...params) => vault.store.read(sql, ...params);
      const byUid = accountByExternalKey(read, bank, uid);
      if (byUid && usable(byUid)) return live() ? { gid: byUid.gid, bank: byUid.bank } : null;
      const normalized = normalizeIban(iban);
      if (!normalized) return null;
      const key = ibanKey(normalized);
      const byIban = accountByIbanKey(read, key);
      return live() && byIban && usable(byIban) ? { gid: byIban.gid, bank: byIban.bank } : null;
    },
    async runImport(input) {
      if (input.profileId !== vault.id || !live() || !input.guard())
        return { ok: false, reason: "banking_authority_changed" };
      const current = () => live() && input.guard();
      const command = defineCommand({
        id: "banking.importAccount",
        input: z.object({}),
        run(ctx: CommandContext) {
          if (
            ctx.vault !== vault.id ||
            !ctx.lease.isHolder() ||
            !enabledModuleIds(ctx.read).has("budget") ||
            !current()
          )
            return refuse("banking_authority_changed");
          if (input.accountGid) {
            const target = accountByGid(ctx.read, input.accountGid);
            if (!target || !usable(target) || target.currency !== input.statement.currency)
              return refuse("banking_account_unavailable");
          }
          const key = ibanKey(input.statement.accountNumber);
          const removed = ctx.read<{ gid: string }>(
            `SELECT gid FROM accounts WHERE removed_at IS NOT NULL AND
              ((bank = ? AND external_id = ?) OR (? <> '' AND (iban_key = ? OR iban_match = ?))) LIMIT 1`,
            input.statement.bank,
            input.externalId,
            key,
            key,
            key,
          )[0];
          if (removed) return refuse("banking_account_unavailable");
          const parsed = importStatement.input.safeParse({
            ...(input.accountGid ? { account: input.accountGid } : {}),
            statement: {
              ...input.statement,
              transactions: [...input.statement.transactions],
              balances: [],
              closingBalances: [...input.statement.closingBalances],
            },
            accountType: input.accountType,
            externalId: input.externalId,
            source: "open_banking",
            newestDayRule: true,
            filename: null,
            notes: null,
          });
          if (!parsed.success) return refuse("invalid_bank_data");
          return importStatement.run(ctx, parsed.data);
        },
      });
      const result = await runHostVaultCommand(
        vault,
        command,
        {},
        randomBytes(16).toString("hex"),
        current,
      );
      if (result.kind === "completed")
        return { ok: true, account: result.value.account, numInserted: result.value.numInserted };
      if (result.kind === "outcome_unknown")
        return {
          ok: false,
          reason: "outcome_unknown",
          attempt: { key: result.key, command: "banking.importAccount" },
        };
      return { ok: false, reason: result.kind === "refused" ? result.reason : result.kind };
    },
  };
}
