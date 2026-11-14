/** Final queued gate for a connector import and its caused cursor event. */
import type { Command, CommandContext } from "@cashu/store";
import { defineCommand, refuse } from "@cashu/store";
import { accountByGid, enabledModuleIds } from "@cashu/store/core";
import { brokerageAccount } from "@cashu/store/investments/queries";
import type { Read } from "@cashu/store/query";
import { z } from "zod";
import { bindingParamsDigest, type TransportBinding } from "./connectors/binding.js";
import type { ConnectorCatalog } from "./connectors/catalog.js";

type ApprovalCatalog = Pick<ConnectorCatalog, "approved">;

interface BindingRow {
  readonly gid: string;
  readonly connector_id: string;
  readonly params_json: string;
  readonly cursor: string | null;
  readonly account_gid: string;
}

/** A transport result is never authority: repeat every mutable check in the store queue. */
export function connectorBindingMatches(
  read: Read,
  vault: string,
  binding: TransportBinding,
  catalog: ApprovalCatalog,
  isHolder: () => boolean,
): boolean {
  if (vault !== binding.profileId || !isHolder()) return false;
  if (!enabledModuleIds(read).has(binding.module)) return false;
  const row = read<BindingRow>(
    `SELECT b.gid, b.connector_id, b.params_json, b.cursor, a.gid AS account_gid
       FROM connector_bindings b JOIN accounts a ON a.id = b.account_id WHERE b.gid = ?`,
    binding.id,
  )[0];
  if (
    row === undefined ||
    row.connector_id !== binding.connectorId ||
    row.account_gid !== binding.accountId ||
    row.cursor !== binding.baseCursor
  )
    return false;
  let params: unknown;
  try {
    params = JSON.parse(row.params_json);
  } catch {
    return false;
  }
  if (
    params === null ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    bindingParamsDigest(params as Record<string, unknown>) !== binding.paramsDigest
  )
    return false;
  const account = accountByGid(read, binding.accountId);
  if (account === undefined || account.removed || account.gid !== binding.accountId) return false;
  if (binding.module === "investments" && brokerageAccount(read, account.gid) === undefined)
    return false;
  if (binding.module === "budget" && brokerageAccount(read, account.gid) !== undefined)
    return false;
  try {
    const approved = catalog.approved(binding.connectorId, binding.interpreter);
    return (
      approved.contentSha256 === binding.approvedCodeDigest &&
      approved.manifest.module === binding.module &&
      approved.manifest.kind === "fetch"
    );
  } catch {
    return false;
  }
}

export function currentConnectorBinding(
  ctx: CommandContext,
  binding: TransportBinding,
  catalog: ApprovalCatalog,
  isHolder: () => boolean,
): boolean {
  return (
    ctx.lease.isHolder() && connectorBindingMatches(ctx.read, ctx.vault, binding, catalog, isHolder)
  );
}

/** The inner import emits the batch; cursor advancement is in that same append and caused by it. */
export function connectorImportCommand<I, R>(input: {
  readonly command: Command<I, R>;
  readonly value: I;
  readonly binding: TransportBinding;
  readonly newCursor: string | null;
  readonly catalog: ApprovalCatalog;
  readonly isHolder: () => boolean;
  readonly permit?: (ctx: CommandContext) => boolean;
}) {
  return defineCommand({
    id: `connector.${input.binding.module}.import`,
    input: z.object({}),
    run(ctx) {
      if (!currentConnectorBinding(ctx, input.binding, input.catalog, input.isHolder))
        return refuse("connector_binding_changed");
      if (input.permit && !input.permit(ctx)) return refuse("auto_import_not_clean");
      let batchEid: string | undefined;
      const capture: CommandContext = {
        ...ctx,
        emit(type, gid, data, opts) {
          const eid = ctx.emit(type, gid, data, opts);
          if (type === "importBatch.recorded" || type === "invImport.recorded") batchEid = eid;
          return eid;
        },
      };
      const result = input.command.run(capture, input.value);
      if (!result.ok) return result;
      if (batchEid === undefined) return refuse("import_batch_missing");
      if (!currentConnectorBinding(ctx, input.binding, input.catalog, input.isHolder))
        return refuse("connector_binding_changed");
      ctx.emit(
        "connectorBinding.cursorAdvanced",
        input.binding.id,
        { cursor: input.newCursor },
        { cause: batchEid },
      );
      return result;
    },
  });
}
