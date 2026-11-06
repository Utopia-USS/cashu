// Ustawienia > Konektory list (ab24ab6 core/ConnectorsSection.tsx `getConnectors` plus the bindings and accounts the
// drawer reads): the installed connectors with their approval state, the profile's accounts and its bindings, as one
// live vault query. The bindings and accounts are vault tables (a binding set or removed by any client re-runs it); the
// installed connectors come from the host's connector catalog, a process-local input whose `changes` fire after an
// install (owner, CLI, MCP `propose_connector`), an approval, a disable or a removal.
import { type ChangeSource, defineQuery } from "../../query.js";

export interface ConnectorSettingsSnapshot {
  readonly connectors: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: "file" | "fetch";
    readonly module: "budget" | "investments";
    readonly contentSha256: string;
    readonly interpreter: string | null;
    readonly approval: "pending" | "approved" | "changed" | "disabled";
    readonly approvedAt: string | null;
    /** Manifest facts; absent when the installed manifest no longer loads. */
    readonly version?: string;
    readonly author?: string | null;
    readonly description?: string | null;
    readonly run?: readonly string[];
    readonly timeoutS?: number;
    readonly hosts?: readonly string[];
    readonly extensions?: readonly string[];
    readonly historyDays?: number | null;
    readonly params: readonly {
      readonly id: string;
      readonly label: string;
      readonly type: string;
      readonly required: boolean;
    }[];
    readonly secrets: readonly { readonly id: string; readonly label: string }[];
  }[];
  readonly accounts: readonly {
    readonly gid: string;
    readonly name: string;
    readonly type: string;
  }[];
  readonly bindings: readonly {
    readonly gid: string;
    readonly account: string;
    readonly connector_id: string;
    readonly params_json: string;
    readonly cursor: string | null;
    readonly auto_commit: number;
  }[];
}
/** The host's installed-connector inventory, bound per vault. */
export interface ConnectorCatalogSource {
  /** Fires after the installed inventory changed (install, approval, disable, removal, a rescan). */
  readonly changes: ChangeSource;
  /** The connectors the owner of `vault` sees; null while this host has no catalog for that vault. */
  connectors(vault: string): ConnectorSettingsSnapshot["connectors"] | null;
}

/** The live connector list; unbound (no host catalog) it answers null, which the section shows as unavailable. */
export function connectorSettingsQuery(source?: ConnectorCatalogSource) {
  return defineQuery({
    id: "core.settings.connectorSettings",
    ...(source === undefined ? {} : { changes: source.changes }),
    run(read, _args: undefined): ConnectorSettingsSnapshot | null {
      const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
      const connectors = vault === undefined ? null : (source?.connectors(vault) ?? null);
      if (connectors === null) return null;
      return {
        connectors,
        accounts: read<{ gid: string; name: string; type: string }>(
          "SELECT gid, name, type FROM accounts WHERE removed_at IS NULL ORDER BY name LIMIT 100",
        ),
        bindings: read<ConnectorSettingsSnapshot["bindings"][number]>(
          `SELECT b.gid, a.gid AS account, b.connector_id, b.params_json, b.cursor, b.auto_commit
             FROM connector_bindings b JOIN accounts a ON a.id = b.account_id
            WHERE a.removed_at IS NULL ORDER BY b.gid LIMIT 100`,
        ),
      };
    },
  });
}

/** The query the renderer names (`useQuery(connectorSettingsSnapshot)`); the host serves its catalog-bound twin. */
export const connectorSettingsSnapshot = connectorSettingsQuery();
