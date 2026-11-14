import { lstatSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { builtinRegistry } from "@cashu/domain/core";
import { mcpProfile } from "@cashu/store/core";
import { listConnectorRuns } from "@cashu/store/device";
import { shippedConnector, shippedConnectorList } from "../cli/connectors/index.js";
import type { ConnectorCatalog } from "../connectors/catalog.js";
import { scanConnector } from "../connectors/manifest.js";
import { testConnectorFileOffline } from "../connectors/offlineTest.js";
import type { OpenDevice, OpenVault } from "../stores.js";
import type { WorkspaceProvider } from "../workspace/index.js";
import { type ConnectorProposalReceipts, connectorRequestHash } from "./connectorReceipt.js";

export interface ConnectorMcpAuthority {
  readonly catalog: ConnectorCatalog;
  readonly vault: OpenVault;
  readonly device: OpenDevice;
  readonly receipts: ConnectorProposalReceipts;
  readonly shippedCatalog?: string;
  readonly workspace?: WorkspaceProvider;
  now(): number;
  isCurrent(): boolean;
}

async function checkedWorkspace(authority: ConnectorMcpAuthority) {
  if (!authority.isCurrent()) throw new Error("connector_mcp_authority_lost");
  const binding = authority.workspace?.bind(authority.vault.id);
  if (!binding?.isCurrent()) throw new Error("connector_workspace_unavailable");
  const profile = mcpProfile(authority.vault.store.read.bind(authority.vault.store));
  if (!profile) throw new Error("connector_profile_unavailable");
  const modules = builtinRegistry().modules;
  const status = await binding.inspect({
    slug: profile.slug,
    privacy: profile.mcpPrivacy === "amounts" ? "amounts" : "strict",
    baseCurrency: profile.baseCurrency,
    modules: [...modules.values()]
      .filter((module) => profile.modules.includes(module.id))
      .map((module) => ({ id: module.id, name: module.name })),
  });
  if (status.availability !== "ready" || !authority.isCurrent() || !binding.isCurrent())
    throw new Error("connector_workspace_unavailable");
  return { path: status.path, current: () => authority.isCurrent() && binding.isCurrent() };
}

function workspaceConnector(path: string, workspace: string): string {
  if (!path || path.includes("\0")) throw new Error("connector_path_invalid");
  const declared = join(workspace, "connectors");
  const root = realpathSync.native(declared);
  if (root !== resolve(declared) || lstatSync(declared).isSymbolicLink())
    throw new Error("connector_path_invalid");
  const source = realpathSync.native(resolve(root, path));
  const rel = relative(root, source);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.split(sep).some((part) => part.startsWith("."))
  )
    throw new Error("connector_path_invalid");
  const loaded = scanConnector(source);
  if (basename(source) !== loaded.manifest.id) throw new Error("connector_path_invalid");
  return source;
}

/** Bound to one current vault. Agent methods can list, test offline, or install pending only. */
export function connectorMcpPort(authority: ConnectorMcpAuthority) {
  return {
    proposalStatus(key: string) {
      return authority.receipts.status(key, authority.vault.id, authority.catalog);
    },
    async testFile(request: {
      readonly path: string;
      readonly file?: string;
      readonly fixture?: string;
    }) {
      const workspace = await checkedWorkspace(authority);
      return testConnectorFileOffline({
        workspaceRoot: workspace.path,
        connectorPath: request.path,
        ...(request.file ? { samplePath: request.file } : {}),
        ...(request.fixture ? { fixturePath: request.fixture } : {}),
        scratchRoot: authority.catalog.root,
        isCurrent: workspace.current,
        now: authority.now,
      });
    },
    async propose(
      request: { readonly path?: string; readonly catalogId?: string },
      requestKey: string,
    ) {
      if (Boolean(request.path) === Boolean(request.catalogId))
        throw new Error("connector_proposal_invalid");
      const requestHash = connectorRequestHash(request);
      const prior = authority.receipts.lookup(requestKey, authority.vault.id);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error("request_key_conflict");
        if (
          authority.receipts.status(requestKey, authority.vault.id, authority.catalog) !==
          "completed"
        )
          throw new Error("connector_mcp_outcome_unknown");
        const completed = authority.receipts.lookup(requestKey, authority.vault.id);
        if (completed?.phase !== "completed") throw new Error("connector_mcp_outcome_unknown");
        return completed.result;
      }
      let source: string;
      let current = authority.isCurrent;
      if (request.catalogId) {
        source =
          shippedConnector(
            {
              catalog: authority.catalog,
              ...(authority.shippedCatalog ? { shippedCatalog: authority.shippedCatalog } : {}),
            },
            request.catalogId,
          ) ?? "";
        if (!source) throw new Error("connector_catalog_entry_unavailable");
      } else {
        const workspace = await checkedWorkspace(authority);
        source = workspaceConnector(request.path ?? "", workspace.path);
        current = workspace.current;
      }
      if (!current()) throw new Error("connector_mcp_authority_lost");
      const preview = scanConnector(source);
      const replaced = authority.catalog.list().some((item) => item.id === preview.manifest.id);
      authority.receipts.begin({
        key: requestKey,
        vault: authority.vault.id,
        requestHash,
        id: preview.manifest.id,
        contentSha256: preview.contentSha256,
        replaced,
      });
      const loaded = authority.catalog.installPending(source);
      if (
        loaded.contentSha256 !== preview.contentSha256 ||
        authority.receipts.status(requestKey, authority.vault.id, authority.catalog) !== "completed"
      )
        throw new Error("connector_mcp_outcome_unknown");
      if (!current()) throw new Error("connector_mcp_outcome_unknown");
      const completed = authority.receipts.lookup(requestKey, authority.vault.id);
      if (completed?.phase !== "completed") throw new Error("connector_mcp_outcome_unknown");
      return completed.result;
    },
    async list() {
      if (!authority.isCurrent()) throw new Error("connector_mcp_authority_lost");
      const installed = authority.catalog.list();
      const counts = authority.vault.store.read<{ id: string; count: number }>(
        `SELECT b.connector_id AS id, COUNT(*) AS count
           FROM connector_bindings b JOIN accounts a ON a.id = b.account_id
          WHERE a.removed_at IS NULL GROUP BY b.connector_id`,
      );
      const byId = new Map(counts.map((row) => [row.id, row.count]));
      const latest = new Map(
        installed.map((item) => [
          item.id,
          listConnectorRuns(authority.device.driver, {
            kind: "vault",
            vault: authority.vault.id,
            connectorId: item.id,
            limit: 1,
          })[0],
        ]),
      );
      const catalog = shippedConnectorList({
        catalog: authority.catalog,
        ...(authority.shippedCatalog ? { shippedCatalog: authority.shippedCatalog } : {}),
      }).map((entry) => {
        const status = installed.find((item) => item.id === entry.id);
        const age =
          entry.lastVerified === null
            ? Number.POSITIVE_INFINITY
            : Math.floor(
                (authority.now() - new Date(`${entry.lastVerified}T00:00:00Z`).getTime()) /
                  86_400_000,
              );
        return {
          ...entry,
          stale: age > 180,
          valid: Number.isFinite(age) && age >= -1,
          installedStatus: status?.approval ?? null,
          installedSameContent: status ? status.contentSha256 === entry.contentSha256 : null,
        };
      });
      if (!authority.isCurrent()) throw new Error("connector_mcp_authority_lost");
      return {
        installed: installed.map(({ id, name, module, kind, approval }) => ({
          id,
          name,
          module,
          kind,
          status: approval,
          bindings: byId.get(id) ?? 0,
          lastRun: latest.get(id)
            ? {
                command: latest.get(id)?.command ?? "",
                outcome: latest.get(id)?.outcome ?? "",
                errorKind: latest.get(id)?.errorKind ?? null,
                at: latest.get(id)?.startedAt ?? "",
                records: latest.get(id)?.records ?? 0,
              }
            : null,
        })),
        catalog,
      };
    },
  };
}
