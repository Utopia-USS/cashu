/** Host-only connector fetch and proposal composition. No renderer path or secret crosses this port. */

import { D, sha256Hex } from "@cashu/domain";
import { type ParsedStatement, planImport } from "@cashu/domain/budget";
import { reportMismatches } from "@cashu/domain/investments/importing";
import type { HostLock } from "@cashu/node-host";
import {
  type Command,
  type CommandContext,
  defineCommand,
  importStatement,
  investmentsCommands,
  mintUlid,
  refuse,
} from "@cashu/store";
import { prepareBudgetConnectorImport } from "@cashu/store/budget/proposals";
import { createProposal, type ExecutionSnapshot, enabledModuleIds } from "@cashu/store/core";
import { type ConnectorFetchUpdate, connectorFetchState } from "@cashu/store/device";
import { brokerageAccount, previewImport } from "@cashu/store/investments/queries";
import {
  type DailyPriceLock,
  prepareInvestmentImport,
  publishCheckedImportBlob,
} from "@cashu/store/investments/services";
import type { Read } from "@cashu/store/query";
import { z } from "zod";
import { runHostVaultCommand } from "./commands.js";
import {
  connectorBindingMatches,
  connectorImportCommand,
  currentConnectorBinding,
} from "./connectorImportCommand.js";
import { type ConnectorBinding, runBoundFetch } from "./connectors/binding.js";
import { ConnectorCatalog, resolveInterpreter } from "./connectors/catalog.js";
import { documentRecords, validateConnectorDocument } from "./connectors/document.js";
import { boundConnectorSecrets } from "./connectors/secrets.js";
import type { ProposalApprovalProvider } from "./proposalsScreen.js";
import type { HostStores, OpenVault } from "./stores.js";
import type { ConnectorFetchPort, JobOutcome } from "./worker/contracts.js";

interface BindingRow {
  readonly id: string;
  readonly account: string;
  readonly connector: string;
  readonly params: string;
  readonly cursor: string | null;
  readonly autoCommit: number;
  readonly currency: string;
  readonly label: string;
}

function bindings(vault: OpenVault): BindingRow[] {
  return vault.store.read<BindingRow>(
    `SELECT b.gid AS id, a.gid AS account, b.connector_id AS connector,
            b.params_json AS params, b.cursor, b.auto_commit AS autoCommit,
            a.currency, a.name AS label
       FROM connector_bindings b JOIN accounts a ON a.id = b.account_id
      WHERE a.removed_at IS NULL ORDER BY b.gid LIMIT 100`,
  );
}

function approvedEarlier(read: Read, bindingId: string): boolean {
  return (
    read<{ present: number }>(
      `SELECT 1 AS present FROM proposals WHERE status = 'approved' AND source = 'connector'
       AND kind IN ('import', 'budget_import') AND json_valid(payload)
       AND json_extract(payload, '$.connector_binding.id') = ? LIMIT 1`,
      bindingId,
    ).length !== 0
  );
}

function budgetPlan(read: Read, account: string, statement: ParsedStatement) {
  const stored = read<{
    dedup_hash: string;
    bank_transaction_id: string | null;
    booking_date: string;
    amount: string;
  }>(
    `SELECT t.dedup_hash, t.bank_transaction_id, t.booking_date, t.amount
       FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE a.gid = ? ORDER BY t.id`,
    account,
  ).map((row) => ({
    dedupHash: row.dedup_hash,
    bankTransactionId: row.bank_transaction_id,
    bookingDate: row.booking_date,
    amount: D(row.amount),
  }));
  return planImport(stored, statement.transactions, { newestDayRule: true });
}

function budgetAutoClean(read: Read, account: string, statement: ParsedStatement): boolean {
  const plan = budgetPlan(read, account, statement);
  return (
    statement.transactions.length > 0 &&
    plan.toInsert.length === statement.transactions.length &&
    plan.numDuplicates === 0 &&
    plan.numOverlap === 0
  );
}

function investmentAutoClean(
  read: Read,
  account: string,
  connector: string,
  name: string,
  bytes: Uint8Array,
  now: number,
): boolean {
  const checked = previewImport(
    read,
    {
      account,
      file: { name: "connector.json", content: bytes },
      importer: `connector:${connector}`,
      connectorName: name,
      boundAccount: true,
    },
    new Date(now).toISOString(),
  );
  if (!checked.ok || !checked.preview.canCommit || checked.preview.warnings.length !== 0)
    return false;
  const plan = checked.preview.plan;
  return (
    plan !== null &&
    plan.rows.length > 0 &&
    plan.rows.every((row) => !row.isDuplicate) &&
    plan.positions.length === 0 &&
    plan.renames.length === 0 &&
    plan.statusChanges.length === 0 &&
    plan.newAliases.size === 0
  );
}

function investmentHasNew(
  read: Read,
  account: string,
  connector: string,
  name: string,
  bytes: Uint8Array,
  now: number,
): boolean {
  const checked = previewImport(
    read,
    {
      account,
      file: { name: "connector.json", content: bytes },
      importer: `connector:${connector}`,
      connectorName: name,
      boundAccount: true,
    },
    new Date(now).toISOString(),
  );
  if (!checked.ok || !checked.preview.canCommit || checked.preview.plan === null) return true;
  const plan = checked.preview.plan;
  return (
    plan.rows.some((row) => !row.isDuplicate) ||
    plan.positions.length > 0 ||
    plan.renames.length > 0 ||
    plan.statusChanges.length > 0 ||
    plan.newInstruments.length > 0 ||
    plan.newAliases.size > 0
  );
}

function autoEnabled(read: Read, bindingId: string): boolean {
  return (
    read<{ auto_commit: number }>(
      "SELECT auto_commit FROM connector_bindings WHERE gid = ?",
      bindingId,
    )[0]?.auto_commit === 1
  );
}

function pending(read: Read, bindingId: string): boolean {
  return (
    read<{ present: number }>(
      `SELECT 1 AS present FROM proposals WHERE status = 'pending'
       AND kind IN ('import', 'budget_import') AND json_valid(payload)
       AND json_extract(payload, '$.connector_binding.id') = ? LIMIT 1`,
      bindingId,
    ).length !== 0
  );
}

/** Python sync parity: empty first fetch is inert; later empty fetch records a caused zero-row batch. */
export function connectorDecision(
  hasNew: boolean,
  priorApproval: boolean,
  autoCommit: boolean,
): "nothing" | "commit" | "proposal" {
  if (!hasNew && !priorApproval) return "nothing";
  if (priorApproval && (!hasNew || autoCommit)) return "commit";
  return "proposal";
}

function paramsOf(text: string): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface ConnectorRuntime {
  readonly catalog: ConnectorCatalog;
  readonly worker: ConnectorFetchPort;
  runOne(vault: OpenVault, bindingId: string, guard: () => void): Promise<JobOutcome>;
  readonly proposals: ProposalApprovalProvider;
}

const proposalBinding = z.strictObject({
  id: z.string().min(1),
  profileId: z.string().min(1),
  accountId: z.string().min(1),
  connectorId: z.string().min(1),
  module: z.enum(["budget", "investments"]),
  baseCursor: z.string().nullable(),
  paramsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  approvedCodeDigest: z.string().regex(/^[0-9a-f]{64}$/),
  interpreter: z.string().min(1),
  newCursor: z.string().nullable(),
});
const blobRef = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  ext: z.string().regex(/^[a-z0-9]{1,10}$/),
});

/** Python `MIN_INTERVAL`: a scheduled sync does not fetch a binding tried less than 20 h ago. */
export const CONNECTOR_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** Python `RATE_LIMIT_BACKOFF`: a `rate_limited` answer holds scheduled syncs of the binding for 48 h. */
export const RATE_LIMIT_BACKOFF_MS = 48 * 60 * 60 * 1000;

/** A finished attempt's fetch state (Python `_finish`, `_backoff`, the commit's `last_ok_at`). */
export function connectorFetchFinish(
  outcome: string,
  errorKind: string | null,
  committed: boolean,
  startedAt: string,
  now: number,
): ConnectorFetchUpdate {
  return {
    lastStatus: outcome,
    ...(committed ? { lastOkAt: startedAt } : {}),
    ...(errorKind === "rate_limited"
      ? { backoffUntil: new Date(now + RATE_LIMIT_BACKOFF_MS).toISOString() }
      : {}),
  };
}

/** Construct only after host admission and HostLock acquisition. */
export function createConnectorRuntime(input: {
  readonly dataDir: string;
  readonly lock: HostLock;
  readonly device: import("@cashu/store/device").DeviceStore;
  readonly stores: HostStores;
  readonly dailyLock: DailyPriceLock;
  readonly current: (vault: OpenVault) => boolean;
  readonly holder: (vault: OpenVault) => boolean;
  /**
   * Refreshes the vault's stale lease pull evidence before `holder` is checked (production:
   * ../fetchAuthority.ts). Awaited before each binding and after each connector process, which
   * may run up to its 600 s timeout, longer than the lease's publish deadline.
   */
  readonly refreshHolder?: (vault: OpenVault) => Promise<unknown>;
  readonly now: () => number;
}): ConnectorRuntime {
  const catalog = new ConnectorCatalog(input.dataDir);
  const busy = new Set<string>();
  const freshHolder = async (vault: OpenVault) => {
    try {
      await input.refreshHolder?.(vault);
    } catch {
      /* A failed refresh grants nothing; `holder` refuses. */
    }
  };
  const fetch = async (
    vault: OpenVault,
    guard: () => void,
    selected?: string,
  ): Promise<JobOutcome> => {
    if (vault.mode !== "native") return { status: "skipped", code: "native_required" };
    const rows = await vault.queue.run(() => {
      guard();
      return bindings(vault).filter((row) => selected === undefined || row.id === selected);
    });
    let stored = 0,
      skipped = 0,
      failed = 0;
    for (const row of rows) {
      const key = `${vault.id}:${row.id}`;
      if (busy.has(key)) {
        skipped++;
        continue;
      }
      busy.add(key);
      const started = input.now();
      const startedAt = new Date(started).toISOString();
      let outcome = "failed",
        errorKind: string | null = null,
        bytesOut = 0,
        records = 0,
        stderrTail: string | null = null,
        // A skipped binding ran nothing: no run row, no fetch state (Python records no attempt).
        recorded = true,
        // The connector process was about to start: the binding's fetch state follows this run.
        attempted = false,
        committed = false;
      try {
        await freshHolder(vault);
        guard();
        const loaded = catalog.installed(row.connector);
        const interpreter = resolveInterpreter(loaded);
        const module = loaded.manifest.module;
        if (
          loaded.manifest.kind !== "fetch" ||
          !enabledModuleIds(vault.store.read.bind(vault.store)).has(module)
        ) {
          skipped++;
          recorded = false;
          continue;
        }
        if (pending(vault.store.read.bind(vault.store), row.id)) {
          skipped++;
          recorded = false;
          continue;
        }
        // Python `due()`: a scheduled sync skips a binding while a rate-limit backoff holds or when it was tried less
        // than 20 h ago (banks throttle PSD2); an owner's sync of the binding still runs.
        const state =
          selected === undefined
            ? connectorFetchState(input.device.driver, vault.id, row.id)
            : undefined;
        if (
          (state?.backoffUntil && Date.parse(state.backoffUntil) > input.now()) ||
          (state?.lastRunAt &&
            Date.parse(state.lastRunAt) + CONNECTOR_MIN_INTERVAL_MS > input.now())
        ) {
          skipped++;
          recorded = false;
          continue;
        }
        const params = paramsOf(row.params);
        if (params === null) {
          failed++;
          errorKind = "bad_request";
          continue;
        }
        const binding: ConnectorBinding = {
          id: row.id,
          profileId: vault.id,
          accountId: row.account,
          connectorId: row.connector,
          module,
          enabled: true,
          params,
          cursor: row.cursor,
        };
        if (
          module === "investments" &&
          brokerageAccount(vault.store.read.bind(vault.store), row.account) === undefined
        ) {
          failed++;
          errorKind = "bad_request";
          continue;
        }
        if (
          module === "budget" &&
          brokerageAccount(vault.store.read.bind(vault.store), row.account) !== undefined
        ) {
          failed++;
          errorKind = "bad_request";
          continue;
        }
        const current = () => {
          try {
            guard();
            return input.current(vault) && input.holder(vault);
          } catch {
            return false;
          }
        };
        const secrets = boundConnectorSecrets({
          catalog,
          binding,
          interpreter,
          authority: {
            dataDir: input.dataDir,
            lock: input.lock,
            isOwnerAction: () => false,
            isCurrent(identity) {
              return (
                current() &&
                identity.profileId === vault.id &&
                identity.bindingId === binding.id &&
                identity.connectorId === binding.connectorId &&
                vault.store.read<{ gid: string }>(
                  "SELECT gid FROM connector_bindings WHERE gid = ? AND connector_id = ?",
                  binding.id,
                  binding.connectorId,
                ).length === 1
              );
            },
          },
        });
        attempted = true;
        input.device.updateConnectorFetch(vault.id, row.id, { lastRunAt: startedAt });
        const fetched = await runBoundFetch({
          catalog,
          binding,
          account: {
            id: row.account,
            profileId: vault.id,
            module,
            currency: row.currency,
            label: row.label,
          },
          authority: { profileId: vault.id, holder: true, isCurrent: current },
          secrets,
          interpreter,
        });
        stderrTail = fetched.stderrTail ?? null;
        await freshHolder(vault);
        if (fetched.outcome !== "transported") {
          failed++;
          outcome = fetched.outcome;
          errorKind = fetched.errorKind;
          continue;
        }
        bytesOut = fetched.documentBytes.length;
        records = documentRecords(module, fetched.documentBytes);
        const validated = validateConnectorDocument(module, fetched.documentBytes);
        if (!validated.ok) {
          failed++;
          errorKind = validated.code;
          continue;
        }
        let previewSummary: Record<string, number>;
        if (validated.module === "investments") {
          const preview = previewImport(
            vault.store.read.bind(vault.store),
            {
              account: row.account,
              file: { name: "connector.json", content: fetched.documentBytes },
              importer: `connector:${row.connector}`,
              connectorName: loaded.manifest.name,
              boundAccount: true,
            },
            new Date(input.now()).toISOString(),
          );
          if (!preview.ok || !preview.preview.canCommit) {
            failed++;
            errorKind = "import_blocked";
            continue;
          }
          const plan = preview.preview.plan;
          previewSummary = {
            new: plan?.rows.filter((entry) => !entry.isDuplicate).length ?? 0,
            duplicates: plan?.rows.filter((entry) => entry.isDuplicate).length ?? 0,
            warnings: preview.preview.warnings.length,
            errors: preview.preview.errors.length,
            reconciliation_mismatches: preview.preview.reconciliation
              ? reportMismatches(preview.preview.reconciliation).length
              : 0,
          };
        } else {
          const plan = budgetPlan(
            vault.store.read.bind(vault.store),
            row.account,
            validated.statement,
          );
          previewSummary = {
            new: plan.toInsert.length,
            duplicates: plan.numDuplicates,
            warnings: validated.warnings,
            errors: 0,
          };
        }
        const hasNew =
          validated.module === "budget"
            ? budgetPlan(vault.store.read.bind(vault.store), row.account, validated.statement)
                .toInsert.length > 0
            : investmentHasNew(
                vault.store.read.bind(vault.store),
                row.account,
                row.connector,
                loaded.manifest.name,
                fetched.documentBytes,
                input.now(),
              );
        const priorApproval = approvedEarlier(vault.store.read.bind(vault.store), row.id);
        const decision = connectorDecision(hasNew, priorApproval, row.autoCommit === 1);
        if (decision === "nothing") {
          // The process ran clean with nothing new: an ok run (Python), counted as skipped by the worker.
          skipped++;
          outcome = "ok";
          continue;
        }
        const publication = vault.native.blobPublication();
        if (!publication || !current()) {
          failed++;
          errorKind = "authority_lost";
          continue;
        }
        const published = await publishCheckedImportBlob(publication, vault.id, {
          name: "connector.json",
          content: fetched.documentBytes,
        });
        if (!current()) {
          failed++;
          errorKind = "authority_lost";
          continue;
        }
        const checked = { ...fetched.binding, newCursor: fetched.newCursor };
        const permit = (ctx: CommandContext) => {
          if (!approvedEarlier(ctx.read, row.id) || pending(ctx.read, row.id)) return false;
          if (!hasNew)
            return validated.module === "budget"
              ? budgetPlan(ctx.read, row.account, validated.statement).toInsert.length === 0
              : !investmentHasNew(
                  ctx.read,
                  row.account,
                  row.connector,
                  loaded.manifest.name,
                  fetched.documentBytes,
                  input.now(),
                );
          if (!autoEnabled(ctx.read, row.id) || validated.warnings !== 0) return false;
          return validated.module === "budget"
            ? budgetAutoClean(ctx.read, row.account, validated.statement)
            : investmentAutoClean(
                ctx.read,
                row.account,
                row.connector,
                loaded.manifest.name,
                fetched.documentBytes,
                input.now(),
              );
        };
        if (decision === "commit") {
          const command =
            validated.module === "budget"
              ? connectorImportCommand({
                  command: importStatement,
                  value: importStatement.input.parse({
                    account: row.account,
                    account_label: row.label,
                    connector_name: loaded.manifest.name,
                    preview: previewSummary,
                    statement: validated.statement,
                    source: "connector",
                    filename: "connector.json",
                    archive: published.blob,
                    newestDayRule: true,
                  }),
                  binding: fetched.binding,
                  newCursor: fetched.newCursor,
                  catalog,
                  isHolder: current,
                  permit,
                })
              : connectorImportCommand({
                  command: investmentsCommands.commitImport,
                  value: investmentsCommands.commitImport.input.parse({
                    account: row.account,
                    file: { name: "connector.json", content: fetched.documentBytes },
                    importer: `connector:${row.connector}`,
                    connectorName: loaded.manifest.name,
                    boundAccount: true,
                    archive: published.blob,
                  }),
                  binding: fetched.binding,
                  newCursor: fetched.newCursor,
                  catalog,
                  isHolder: current,
                  permit,
                });
          const auto = await runHostVaultCommand(
            vault,
            command as Command<Record<string, never>, unknown>,
            {},
            mintUlid(input.now()),
            current,
          );
          if (auto.kind === "completed") {
            stored++;
            outcome = "ok";
            committed = true;
            continue;
          }
          if (auto.kind !== "refused" || auto.reason !== "auto_import_not_clean") {
            failed++;
            errorKind = auto.kind === "refused" ? auto.reason : "outcome_unknown";
            continue;
          }
        }
        const proposal = defineCommand({
          id: "connector.createImportProposal",
          input: z.object({}),
          run(ctx) {
            if (
              !currentConnectorBinding(ctx, fetched.binding, catalog, () => current()) ||
              pending(ctx.read, row.id)
            )
              return refuse("connector_binding_changed");
            return createProposal.run(
              ctx,
              createProposal.input.parse({
                kind: module === "budget" ? "budget_import" : "import",
                source: "connector",
                reason: null,
                // Python connectors/sync.py: the English line and its values for the app's localized one.
                ...(module === "budget"
                  ? {
                      summary: `Statement import into ${row.label} (connector ${loaded.manifest.name}): ${previewSummary.new} new transactions`,
                      summaryParams: {
                        account: row.label,
                        connector: loaded.manifest.name,
                        new: previewSummary.new,
                      },
                    }
                  : {
                      summary: `Import into ${row.label} (connector ${loaded.manifest.name}): ${previewSummary.new} new rows`,
                      summaryParams: {
                        account: row.label,
                        importer: `connector:${row.connector}`,
                        connector: loaded.manifest.name,
                        new: previewSummary.new,
                        duplicates: previewSummary.duplicates,
                      },
                    }),
                payload: {
                  account: row.account,
                  blob: published.blob,
                  file_name: "connector.json",
                  file_sha256: sha256Hex(fetched.documentBytes),
                  source: "connector",
                  connector_binding: checked,
                  ...(module === "investments"
                    ? {
                        importer: `connector:${row.connector}`,
                      }
                    : {}),
                },
              }),
            );
          },
        });
        const result = await runHostVaultCommand(
          vault,
          proposal,
          {},
          mintUlid(input.now()),
          current,
        );
        if (result.kind !== "completed") {
          failed++;
          errorKind = result.kind === "refused" ? result.reason : "outcome_unknown";
          continue;
        }
        stored++;
        outcome = "ok";
      } catch {
        failed++;
        errorKind = "internal";
      } finally {
        busy.delete(key);
        try {
          if (recorded)
            input.device.appendConnectorRun({
              connectorId: row.connector,
              vault: vault.id,
              binding: row.id,
              command: "fetch",
              startedAt,
              durationMs: Math.max(0, input.now() - started),
              outcome,
              errorKind,
              exitCode: null,
              records,
              bytesIn: 0,
              bytesOut,
              deniedHostsJson: "[]",
              stderrTail,
              proposalId: null,
              batchRef: null,
            });
          if (attempted)
            input.device.updateConnectorFetch(
              vault.id,
              row.id,
              connectorFetchFinish(outcome, errorKind, committed, startedAt, input.now()),
            );
        } catch {
          /* Audit failure is reflected by the worker's failed outcome below. */ failed++;
        }
      }
    }
    return {
      status: failed > 0 ? (stored > 0 ? "partial" : "failed") : "ok",
      stats: { stored, skipped, failed },
    };
  };
  const worker: ConnectorFetchPort = { fetch: (vault, guard) => fetch(vault, guard) };
  const proposals: ProposalApprovalProvider = {
    bind(id) {
      const vault = input.stores.vaults.get(id);
      if (vault?.mode !== "native" || !input.current(vault)) return null;
      const publication = vault.native.blobPublication();
      if (!publication) return null;
      const isCurrent = () =>
        input.stores.vaults.get(id) === vault && input.current(vault) && publication.isCurrent();
      const holder = () => isCurrent() && input.holder(vault);
      return {
        generation: `${id}:${vault.native.device}`,
        dailyLock: input.dailyLock,
        isCurrent,
        isHolder: holder,
        async prepare(snapshot: ExecutionSnapshot) {
          if (!isCurrent() || !holder()) throw new Error("connector_authority_unavailable");
          // An agent's MCP propose_import (no connector): the file it published, checked again.
          if (snapshot.kind === "import" && snapshot.payload.source !== "connector") {
            const prepared = await prepareInvestmentImport(
              { store: vault.store, blobs: publication, isHolder: holder, now: input.now },
              snapshot,
            );
            if (!prepared.ok) throw new Error(prepared.reason);
            return { effect: prepared.value };
          }
          const parsed = proposalBinding.safeParse(snapshot.payload.connector_binding);
          if (
            !parsed.success ||
            parsed.data.profileId !== id ||
            parsed.data.module !== (snapshot.kind === "budget_import" ? "budget" : "investments")
          )
            throw new Error("connector_binding_unavailable");
          const binding = parsed.data;
          if (
            !connectorBindingMatches(
              vault.store.read.bind(vault.store),
              id,
              binding,
              catalog,
              holder,
            )
          )
            throw new Error("connector_binding_changed");
          if (snapshot.kind === "import") {
            const prepared = await prepareInvestmentImport(
              {
                store: vault.store,
                blobs: publication,
                isHolder: holder,
                now: input.now,
                connector: {
                  precheck: (read, checked) =>
                    connectorBindingMatches(read, id, checked, catalog, holder),
                  check: (ctx, checked) => currentConnectorBinding(ctx, checked, catalog, holder),
                },
              },
              snapshot,
            );
            if (!prepared.ok) throw new Error(prepared.reason);
            return { effect: prepared.value };
          }
          if (snapshot.kind !== "budget_import") throw new Error("wrong_kind");
          const ref = blobRef.safeParse(snapshot.payload.blob);
          if (!ref.success || snapshot.payload.file_sha256 !== ref.data.sha256)
            throw new Error("invalid_blob_ref");
          const bytes = await publication.read(id, ref.data, 64 * 1024 * 1024);
          if (!bytes || !holder() || sha256Hex(bytes) !== ref.data.sha256)
            throw new Error("staged_changed");
          const validated = validateConnectorDocument("budget", bytes);
          if (!validated.ok || validated.module !== "budget") throw new Error("invalid_document");
          const prepared = prepareBudgetConnectorImport({
            read: vault.store.read.bind(vault.store),
            snapshot,
            vault: id,
            statement: validated.statement,
            check: (ctx, checked) => currentConnectorBinding(ctx, checked, catalog, holder),
          });
          if (!prepared.ok) throw new Error(prepared.reason);
          return { effect: prepared.value };
        },
      };
    },
  };
  return {
    catalog,
    worker,
    runOne: (vault, bindingId, guard) => fetch(vault, guard, bindingId),
    proposals,
  };
}
