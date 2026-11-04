import * as L from "../privacy/labels.js";
import { ToolError, type ToolSpec, toolSpec } from "../registry.js";
import { mcpToolMetadata } from "../runtime/metadata.js";
import type { NativeToolStore } from "../runtime/types.js";

const RULE =
  "The app runs an installed connector only after the owner approves it in the app (Ustawienia > Konektory); MCP calls never install as approved and never approve.";
const CATALOG_NOTE =
  "catalog: community connectors shipped with the app. Check it before writing a new connector; install an entry for the owner's review with propose_connector(catalog_id=...).";

/** Preserve the frozen Python schemas; only a bound native authority may advertise a handler. */
export function connectorTools(): readonly ToolSpec<NativeToolStore>[] {
  const metadata = mcpToolMetadata().filter((row) =>
    ["test_connector", "propose_connector", "connectors"].includes(row.name),
  );
  return metadata.map((row) =>
    toolSpec<NativeToolStore>({
      ...row,
      async handler(ctx, args): Promise<L.LabelledTree> {
        const port = ctx.store.connectors;
        if (!port)
          throw new ToolError("connector catalog unavailable", "unavailable", { system: true });
        if (row.name === "propose_connector") {
          const path = typeof args.path === "string" ? args.path : undefined;
          const catalogId = typeof args.catalog_id === "string" ? args.catalog_id : undefined;
          if (Boolean(path) === Boolean(catalogId))
            throw new ToolError("give either path or catalog_id", "invalid", { system: true });
          const result = await port.propose({
            ...(path ? { path } : {}),
            ...(catalogId ? { catalogId } : {}),
          });
          return {
            id: L.category(result.id),
            status: L.category(result.status),
            replaced: L.flag(result.replaced),
            content_sha256: L.text(result.contentSha256.slice(0, 12)),
            module: L.category(result.module),
            kind: L.category(result.kind),
            hosts: result.hosts.map(L.text),
            secret_ids: result.secretIds.map(L.category),
            note: L.fixedText("installed for review; only the owner approves it in the app"),
          };
        }
        if (row.name === "test_connector") {
          const file = typeof args.file === "string" ? args.file : undefined;
          const fixture = typeof args.fixture === "string" ? args.fixture : undefined;
          if (typeof args.path !== "string" || Boolean(file) === Boolean(fixture))
            throw new ToolError(
              "give path and exactly one of file or fixture for an offline connector test",
              "invalid",
              { system: true },
            );
          const report = await port.testFile({
            path: args.path,
            ...(file ? { file } : {}),
            ...(fixture ? { fixture } : {}),
          });
          return {
            ok: L.flag(report.ok),
            manifest: {
              valid: L.flag(report.id !== null),
              id: L.category(report.id),
              version: L.category(report.version),
              module: L.category(report.module),
              kind: L.category(report.kind),
              interpreter: L.fixedText(report.interpreter),
              issues: [],
            },
            runs: report.runs.map((run) => ({
              command: L.category(run.command),
              outcome: L.category(run.outcome),
              error_kind: L.category(run.errorKind),
              records: L.count(run.records),
              message: L.fixedText(run.errorKind === null ? "ok" : "the test failed"),
            })),
            detect: report.detect === null ? null : { match: L.flag(report.detect) },
            document:
              report.documentValid === null || report.document === null
                ? null
                : {
                    valid: L.flag(report.documentValid),
                    format: L.category(report.document.format),
                    counts: Object.fromEntries(
                      Object.entries(report.document.counts).map(([key, value]) => [
                        key,
                        L.count(value),
                      ]),
                    ),
                    issue_kinds: report.document.issueKinds.map(L.category),
                  },
            note: L.fixedText(
              "test_connector ran a private copy once in the sandbox, offline; nothing was installed, approved or recorded.",
            ),
          };
        }
        const result = await port.list();
        return {
          connectors: result.installed.map((item) => ({
            id: L.category(item.id),
            name: L.text(item.name),
            module: L.category(item.module),
            kind: L.category(item.kind),
            status: L.category(item.status),
            last_run:
              item.lastRun === null
                ? null
                : {
                    command: L.category(item.lastRun.command),
                    outcome: L.category(item.lastRun.outcome),
                    error_kind: L.category(item.lastRun.errorKind),
                    at: L.date(item.lastRun.at),
                    records: L.count(item.lastRun.records),
                  },
            bindings: L.count(item.bindings),
          })),
          catalog: result.catalog.map((item) => ({
            id: L.category(item.id),
            name: L.text(item.name),
            module: L.category(item.module),
            kind: L.category(item.kind),
            version: L.text(item.version),
            maintainer: L.text(item.maintainer),
            last_verified: L.date(item.lastVerified),
            stale: L.flag(item.stale),
            valid: L.flag(true),
            installed_status: L.category(item.installedStatus),
            installed_same_content: L.flag(item.installedSameContent),
          })),
          catalog_note: L.fixedText(CATALOG_NOTE),
          rule: L.fixedText(RULE),
        };
      },
    }),
  );
}
