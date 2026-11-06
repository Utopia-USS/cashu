import { builtinRegistry, cleanCurrency, cleanModules, cleanName } from "@cashu/domain/core";
import { z } from "zod";
import { defineCommand, ok, refuse } from "../../command.js";
import { vaultId } from "../../events/v1/primitives.js";
import { defineQuery } from "../../query.js";
import type { UiAction } from "../../ui-actions.js";
import { profileOf } from "../queries.js";

export {
  CONNECTOR_RUNS_LISTED,
  type ConnectorActivity,
  type ConnectorBindingSync,
  type ConnectorRunView,
  connectorActivity,
} from "./connector-activity.js";
export {
  type ConnectorCatalogSource,
  type ConnectorSettingsSnapshot,
  connectorSettingsQuery,
  connectorSettingsSnapshot,
} from "./connector-settings.js";
export {
  type DeviceListSource,
  type DeviceListState,
  deviceListQuery,
  deviceListState,
} from "./device-list.js";
export { type HostSettingsInfo, hostSettingsInfo } from "./host-info.js";
export { type WorkspaceStatusState, workspaceStatus } from "./workspace-status.js";

const registry = builtinRegistry();

/** Save both owner profile fields in one event append. The readable name is not vault identity. */
export const saveProfile = defineCommand({
  id: "core.settings.saveProfile",
  input: z.object({ name: z.string(), baseCurrency: z.string() }),
  run(ctx, input) {
    const current = profileOf(ctx.read);
    if (current === undefined) return refuse("no_profile");
    const name = cleanName(input.name);
    if (!name.ok) return refuse("invalid_name");
    const currency = cleanCurrency(input.baseCurrency);
    if (!currency.ok) return refuse("invalid_currency");
    if (name.value !== current.name) ctx.emit("profile.renamed", ctx.vault, { name: name.value });
    if (currency.value !== current.baseCurrency)
      ctx.emit("profile.settingsChanged", ctx.vault, { baseCurrency: currency.value });
    return ok({ name: name.value, baseCurrency: currency.value });
  },
});

/** Module toggle intent against the latest folded selection, using the canonical registry. */
export function toggledModules(current: readonly string[], moduleId: string): string[] | null {
  if (!registry.modules.has(moduleId)) return null;
  const selected = new Set(current);
  if (selected.has(moduleId)) {
    selected.delete(moduleId);
    // Removing a dependency also removes every module that would pull it back in.
    for (const id of registry.modules.keys()) {
      if (!selected.has(id)) continue;
      const closure = cleanModules(registry, [id]);
      if (closure.ok && closure.value.includes(moduleId)) selected.delete(id);
    }
  } else selected.add(moduleId);
  const cleaned = cleanModules(registry, selected);
  return cleaned.ok ? cleaned.value : null;
}

export interface AuditCall {
  readonly id: number;
  readonly tool: string;
  readonly calledAt: string;
  readonly privacy: string;
  readonly outcome: string;
  readonly errorKind: string | null;
  readonly durationMs: number;
  readonly arguments: readonly { readonly name: string; readonly type: string }[];
  readonly unknownArgumentCount: number;
}

/** Exact selected-vault audit projection. Stored argument values never cross this query. */
export const mcpAudit = defineQuery({
  id: "device.settings.mcpAudit",
  scope: "device",
  run(read, args: { readonly vault: string; readonly since: string; readonly privacy: boolean }) {
    if (args.privacy) return { calls: [], count7d: 0, hidden: true };
    if (!vaultId.safeParse(args.vault).success) return { calls: [], count7d: 0, hidden: false };
    const rows = read<{
      id: number;
      tool: string;
      calledAt: string;
      args: string;
      privacy: string;
      outcome: string;
      errorKind: string | null;
      durationMs: number;
    }>(
      `SELECT id, tool, called_at AS calledAt, args, privacy, outcome,
              error_kind AS errorKind, duration_ms AS durationMs
         FROM mcp_calls WHERE vault = ? ORDER BY id DESC LIMIT 50`,
      args.vault,
    );
    const count7d =
      read<{ count: number }>(
        "SELECT COUNT(*) AS count FROM mcp_calls WHERE vault = ? AND called_at >= ?",
        args.vault,
        args.since,
      )[0]?.count ?? 0;
    return {
      hidden: false,
      calls: rows.map((row): AuditCall => {
        let names: { name: string; type: string }[] = [];
        let unknownArgumentCount = 0;
        try {
          const parsed: unknown = JSON.parse(row.args);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            const entries = Object.entries(parsed);
            const count = entries.find(([name]) => name === "_unknown")?.[1];
            unknownArgumentCount =
              typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
            const types = new Set([
              "null",
              "boolean",
              "integer",
              "number",
              "string",
              "array",
              "object",
              "other",
            ]);
            names = entries
              .filter(
                ([name, type]) =>
                  name !== "_unknown" && typeof type === "string" && types.has(type),
              )
              .slice(0, 40)
              .map(([name, type]) => ({ name, type: type as string }));
          }
        } catch (error) {
          // A malformed old audit row has no displayable argument names.
          if (!(error instanceof SyntaxError)) throw error;
        }
        return {
          id: row.id,
          tool: row.tool,
          calledAt: row.calledAt,
          privacy: row.privacy,
          outcome: row.outcome,
          errorKind: row.errorKind,
          durationMs: row.durationMs,
          arguments: names,
          unknownArgumentCount,
        };
      }),
      count7d,
    };
  },
});

/** Checked host-owned workspace mutation; the status itself is the live `workspaceStatus` query. */
export const workspaceApply: UiAction<
  {
    readonly path?: string;
    readonly force?: boolean;
    readonly routinePermissions?: boolean;
  },
  unknown
> = { id: "core.settings.workspaceApply" };

/** Owner connector controls; the list itself is the live `connectorSettingsSnapshot` query, which follows the host's
 * connector directory by itself. */
export type ConnectorSettingsInput =
  | {
      readonly op: "approve";
      readonly id: string;
      readonly digest: string;
      readonly interpreter: string;
    }
  | { readonly op: "disable"; readonly id: string }
  | { readonly op: "remove"; readonly id: string; readonly allVaults: true }
  | {
      readonly op: "bind";
      readonly id: string;
      readonly account: string;
      readonly params: Readonly<Record<string, string | number | boolean>>;
      readonly autoCommit: boolean;
    }
  | { readonly op: "unbind" | "run"; readonly binding: string }
  | {
      readonly op: "setSecret";
      readonly binding: string;
      readonly secret: string;
      readonly value: string;
    }
  | { readonly op: "clearSecret"; readonly binding: string; readonly secret: string };
export const connectorSettings: UiAction<ConnectorSettingsInput, unknown> = {
  id: "core.settings.connectors",
};
