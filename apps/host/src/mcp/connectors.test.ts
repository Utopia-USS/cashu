import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ConnectorCatalog } from "../connectors/catalog.js";
import { ConnectorProposalReceipts } from "./connectorReceipt.js";
import { connectorMcpPort } from "./connectors.js";

const VAULT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const device = {
  driver: {
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => {
        expect(sql).toContain("vault = ?");
        expect(args[0]).toBe(VAULT);
        return [];
      },
    }),
  },
} as never;

it("counts only bindings in the bound vault and fails closed after authority loss", async () => {
  let current = true;
  const runDevice = {
    driver: {
      prepare: (sql: string) => ({
        all: (...args: unknown[]) => {
          expect(sql).toContain("vault = ?");
          expect(args).toEqual([VAULT, "sample-file", 1]);
          return [
            {
              connectorId: "sample-file",
              command: "fetch",
              outcome: "failed",
              errorKind: "network",
              startedAt: "2026-11-03T12:00:00Z",
              records: 0,
            },
          ];
        },
      }),
    },
  } as never;
  const port = connectorMcpPort({
    catalog: {
      list: () => [
        { id: "sample-file", name: "Sample", module: "budget", kind: "file", approval: "pending" },
      ],
    } as never,
    vault: { id: VAULT, store: { read: () => [{ id: "sample-file", count: 2 }] } } as never,
    device: runDevice,
    receipts: {} as never,
    isCurrent: () => current,
    now: () => Date.parse("2026-11-04T00:00:00Z"),
  });
  expect((await port.list()).installed).toEqual([
    {
      id: "sample-file",
      name: "Sample",
      module: "budget",
      kind: "file",
      status: "pending",
      bindings: 2,
      lastRun: {
        command: "fetch",
        outcome: "failed",
        errorKind: "network",
        at: "2026-11-03T12:00:00Z",
        records: 0,
      },
    },
  ]);
  current = false;
  await expect(port.list()).rejects.toThrow("connector_mcp_authority_lost");
});

it("installs only a checked workspace connector as pending", async () => {
  const root = mkdtempSync("/private/tmp/cashu-mcp-connectors-");
  try {
    const workspace = join(root, "workspace");
    const source = join(workspace, "connectors", "sample-file");
    const data = join(root, "data");
    mkdirSync(source, { recursive: true, mode: 0o700 });
    mkdirSync(data, { mode: 0o700 });
    writeFileSync(
      join(source, "connector.yaml"),
      "api_version: 1\nid: sample-file\nname: Sample\nversion: '1'\nmodule: budget\nkind: file\nrun: [python3, connector.py]\nfile:\n  extensions: [csv]\n",
    );
    writeFileSync(join(source, "connector.py"), "print('synthetic')\n");
    const catalog = new ConnectorCatalog(data);
    const receipts = new ConnectorProposalReceipts(data);
    const port = connectorMcpPort({
      catalog,
      vault: {
        id: VAULT,
        store: {
          read: (sql: string) =>
            sql.includes("FROM profiles")
              ? [
                  {
                    slug: "synthetic",
                    name: "Synthetic",
                    baseCurrency: "PLN",
                    mcpPrivacy: "strict",
                  },
                ]
              : [],
        },
      } as never,
      device,
      receipts,
      workspace: {
        bind: () => ({
          isCurrent: () => true,
          inspect: async () => ({ availability: "ready", path: workspace }),
        }),
      } as never,
      now: () => Date.parse("2026-11-04T00:00:00Z"),
      isCurrent: () => true,
    });
    await expect(port.propose({ path: root }, "bad-path")).rejects.toThrow(
      "connector_path_invalid",
    );
    expect((await port.propose({ path: source }, "install-one")).status).toBe("pending");
    expect(catalog.list()[0]?.approval).toBe("pending");
    const reopened = new ConnectorProposalReceipts(data);
    expect(reopened.status("install-one", VAULT, catalog)).toBe("completed");
    await expect(port.propose({ catalogId: "different" }, "install-one")).rejects.toThrow(
      "request_key_conflict",
    );
    const original = join(workspace, "connectors");
    const moved = join(root, "moved-connectors");
    renameSync(original, moved);
    symlinkSync(moved, original);
    expect((await port.propose({ path: source }, "install-one")).status).toBe("pending");
    await expect(
      port.propose({ path: join(original, "sample-file") }, "install-two"),
    ).rejects.toThrow("connector_path_invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
