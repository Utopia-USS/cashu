import { readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ConnectorCatalog } from "../../connectors/catalog.js";
import { scanConnector } from "../../connectors/manifest.js";
import { testConnectorFileOffline } from "../../connectors/offlineTest.js";
import type { CommandIo, PortedCommand } from "../tree.js";
import { M } from "./strings.js";

export interface ConnectorCliDeps {
  readonly catalog: ConnectorCatalog;
  readonly isCurrent?: () => boolean;
  /** Host-authenticated destructive controls. CLI never manufactures owner authority. */
  readonly disable?: (id: string, signal: AbortSignal) => Promise<void>;
  readonly remove?: (id: string, signal: AbortSignal) => Promise<{ readonly bindings: number }>;
  /** A fixed, bundled, read-only catalog root established by the host. */
  readonly shippedCatalog?: string;
}

const id = (value: string): boolean => /^[a-z][a-z0-9-]{1,39}$/.test(value) && value !== "catalog";

/** Read only from the fixed package root. No source path comes from an agent or terminal here. */
export function shippedConnector(deps: ConnectorCliDeps, connectorId: string): string | null {
  if (!id(connectorId) || !deps.shippedCatalog) return null;
  try {
    const root = realpathSync.native(deps.shippedCatalog);
    const path = realpathSync.native(join(root, connectorId));
    if (!path.startsWith(`${root}${sep}`)) return null;
    const loaded = scanConnector(path);
    return loaded.manifest.id === connectorId &&
      loaded.manifest.maintainer &&
      loaded.manifest.last_verified
      ? path
      : null;
  } catch {
    return null;
  }
}

export function shippedConnectorList(deps: ConnectorCliDeps): readonly {
  readonly id: string;
  readonly name: string;
  readonly module: string;
  readonly kind: string;
  readonly version: string;
  readonly maintainer: string | null;
  readonly lastVerified: string | null;
  readonly countries: readonly string[] | null;
  readonly contentSha256: string;
}[] {
  if (!deps.shippedCatalog) return [];
  try {
    const root = realpathSync.native(deps.shippedCatalog);
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && id(entry.name))
      .slice(0, 100)
      .flatMap((entry) => {
        const source = shippedConnector(deps, entry.name);
        if (!source) return [];
        const { manifest, contentSha256 } = scanConnector(source);
        return [
          {
            id: manifest.id,
            name: manifest.name,
            module: manifest.module,
            kind: manifest.kind,
            version: manifest.version,
            maintainer: manifest.maintainer ?? null,
            lastVerified: manifest.last_verified ?? null,
            countries: manifest.countries ?? null,
            contentSha256,
          },
        ];
      });
  } catch {
    return [];
  }
}

export function connectorCommands(deps: ConnectorCliDeps): readonly PortedCommand[] {
  return [
    {
      name: "connectors",
      async run(args, io: CommandIo) {
        if (deps.isCurrent && !deps.isCurrent()) {
          io.stderr(`${io.t.tr(M.unavailable)}\n`);
          return 69;
        }
        const [action, first, second] = args;
        if (action === "list" && args.length === 1) {
          io.stdout(
            `${JSON.stringify(deps.catalog.list().map(({ id, name, kind, module, approval }) => ({ id, name, kind, module, status: approval })))}\n`,
          );
          return 0;
        }
        if (action === "show" && args.length === 2 && first && id(first)) {
          try {
            const loaded = deps.catalog.installed(first);
            const state =
              deps.catalog.list().find((item) => item.id === first)?.approval ?? "pending";
            io.stdout(
              `${JSON.stringify({ id: first, name: loaded.manifest.name, module: loaded.manifest.module, kind: loaded.manifest.kind, version: loaded.manifest.version, status: state })}\n`,
            );
            return 0;
          } catch {
            io.stderr(`${io.t.tr(M.invalid)}\n`);
            return 1;
          }
        }
        if (
          action === "add" &&
          (args.length === 2 || args.length === 3) &&
          first &&
          (args.length === 2 || second === "--replace")
        ) {
          try {
            const path = resolve(io.cwd, first);
            const loaded = scanConnector(path);
            if (
              deps.catalog.list().some((entry) => entry.id === loaded.manifest.id) &&
              second !== "--replace"
            ) {
              io.stderr(`${io.t.tr(M.exists)}\n`);
              return 1;
            }
            deps.catalog.installPending(path);
            io.stdout(`${io.t.tr(M.pending)}\n`);
            return 0;
          } catch {
            io.stderr(`${io.t.tr(M.invalid)}\n`);
            return 1;
          }
        }
        if (action === "catalog" && first === "list" && args.length === 2) {
          if (!deps.shippedCatalog) {
            io.stderr(`${io.t.tr(M.unavailable)}\n`);
            return 69;
          }
          io.stdout(`${JSON.stringify(shippedConnectorList(deps))}\n`);
          return 0;
        }
        if (action === "catalog" && first === "add" && args.length === 3 && second) {
          const source = shippedConnector(deps, second);
          if (!source) {
            io.stderr(`${io.t.tr(M.invalid)}\n`);
            return 1;
          }
          try {
            if (deps.catalog.list().some((entry) => entry.id === second)) {
              io.stderr(`${io.t.tr(M.exists)}\n`);
              return 1;
            }
            deps.catalog.installPending(source);
            io.stdout(`${io.t.tr(M.pending)}\n`);
            return 0;
          } catch {
            io.stderr(`${io.t.tr(M.invalid)}\n`);
            return 1;
          }
        }
        if (action === "disable" && args.length === 2 && first && id(first)) {
          if (!deps.disable) {
            io.stderr(`${io.t.tr(M.unavailable)}\n`);
            return 69;
          }
          try {
            await deps.disable(first, io.signal);
            io.stdout(`${io.t.tr(M.disabled)}\n`);
            return 0;
          } catch {
            io.stderr(`${io.t.tr(M.unavailable)}\n`);
            return 69;
          }
        }
        if (
          action === "remove" &&
          (args.length === 2 || args.length === 3) &&
          first &&
          id(first) &&
          (args.length === 2 || second === "--yes")
        ) {
          if (!deps.remove) {
            io.stderr(`${io.t.tr(M.unavailable)}\n`);
            return 69;
          }
          if (second !== "--yes") {
            if (!io.tty.stdin) {
              io.stderr(`${io.t.tr(M.unavailable)}\n`);
              return 69;
            }
            const answer = (await io.prompt(io.t.tr(M.confirmRemove)))?.trim().toLowerCase();
            if (answer !== "y" && answer !== "yes" && answer !== "t" && answer !== "tak") return 1;
          }
          try {
            await deps.remove(first, io.signal);
            io.stdout(`${io.t.tr(M.removed)}\n`);
            return 0;
          } catch {
            io.stderr(`${io.t.tr(M.unavailable)}\n`);
            return 69;
          }
        }
        if (
          action === "test" &&
          args.length === 4 &&
          first &&
          (second === "--file" || second === "--fixture") &&
          args[3]
        ) {
          const report = await testConnectorFileOffline({
            workspaceRoot: io.cwd,
            connectorPath: resolve(io.cwd, first),
            ...(second === "--file"
              ? { samplePath: resolve(io.cwd, args[3]) }
              : { fixturePath: resolve(io.cwd, args[3]) }),
            scratchRoot: deps.catalog.root,
            isCurrent: () => !io.signal.aborted,
          });
          io.stdout(`${JSON.stringify(report)}\n`);
          return report.ok ? 0 : 1;
        }
        if (["disable", "remove", "test", "secret"].includes(action ?? "")) {
          io.stderr(`${io.t.tr(M.unavailable)}\n`);
          return 69;
        }
        io.stderr(`${io.t.tr(M.usage)}\n`);
        return 2;
      },
    },
  ];
}
