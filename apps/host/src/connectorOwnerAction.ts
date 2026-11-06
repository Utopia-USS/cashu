/** Owner Settings controls for installed connectors and exact vault bindings. */

import {
  type Command,
  type CommandContext,
  type DurableCommandResult,
  defineCommand,
  mintUlid,
  ok,
  refuse,
  v1,
} from "@cashu/store";
import { accountByGid, enabledModuleIds } from "@cashu/store/core";
import { brokerageAccount } from "@cashu/store/investments/queries";
import { z } from "zod";
import { runHostVaultCommand } from "./commands.js";
import { connectorBindingMatches } from "./connectorImportCommand.js";
import { removeConnectorOwner } from "./connectorRemoval.js";
import type { ConnectorRuntime } from "./connectorRuntime.js";
import { bindingParamsDigest, type ConnectorBinding } from "./connectors/binding.js";
import { resolveInterpreter } from "./connectors/catalog.js";
import { boundConnectorSecrets } from "./connectors/secrets.js";
import type { HostStores, OpenVault } from "./stores.js";
import { type UiActionRegistration, unknownUiCommand } from "./uiActions.js";
import type { WorkerBindings } from "./worker/contracts.js";
import { reportSuccessfulFetch } from "./worker/leaseReport.js";

const gid = v1.gid;
const id = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const request = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("approve"),
    id,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    interpreter: z.string().min(1),
  }),
  z.strictObject({ op: z.literal("disable"), id }),
  z.strictObject({ op: z.literal("remove"), id, allVaults: z.literal(true) }),
  z.strictObject({
    op: z.literal("bind"),
    id,
    account: gid,
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .refine((v) => JSON.stringify(v).length <= 4096),
    autoCommit: z.boolean(),
  }),
  z.strictObject({ op: z.literal("unbind"), binding: gid }),
  z.strictObject({
    op: z.literal("setSecret"),
    binding: gid,
    secret: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    value: z.string().min(1).max(4096),
  }),
  z.strictObject({
    op: z.literal("clearSecret"),
    binding: gid,
    secret: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  }),
  z.strictObject({ op: z.literal("run"), binding: gid }),
]);

interface BindingRow {
  gid: string;
  account: string;
  connector_id: string;
  params_json: string;
  cursor: string | null;
  auto_commit: number;
}

function bindingRow(vault: OpenVault, binding: string): BindingRow | undefined {
  return vault.store.read<BindingRow>(
    `SELECT b.gid, a.gid AS account, b.connector_id, b.params_json, b.cursor, b.auto_commit
       FROM connector_bindings b JOIN accounts a ON a.id = b.account_id
      WHERE b.gid = ? AND a.removed_at IS NULL`,
    binding,
  )[0];
}

function validAccount(ctx: CommandContext, account: string, module: string): boolean {
  const row = accountByGid(ctx.read, account);
  if (!row || row.removed || !enabledModuleIds(ctx.read).has(module)) return false;
  const brokerage = brokerageAccount(ctx.read, account) !== undefined;
  return module === "investments" ? brokerage : !brokerage;
}

export function connectorOwnerAction(input: {
  runtime(): ConnectorRuntime | undefined;
  worker(): WorkerBindings | undefined;
  readonly dataDir: string;
  lock(): import("@cashu/node-host").HostLock | undefined;
  readonly now: () => number;
  /** Synthetic tests only. Production uses the durable host command and OS secret service. */
  readonly execute?: (
    vault: OpenVault,
    command: Command<Record<string, never>, unknown>,
    current: () => boolean,
  ) => Promise<DurableCommandResult<unknown>>;
  readonly makeSecrets?: typeof boundConnectorSecrets;
  readonly remove?: typeof removeConnectorOwner;
}): UiActionRegistration {
  const unresolved = new Map<
    string,
    { identity: string; result: ReturnType<typeof unknownUiCommand> }
  >();
  let mutationBusy = false;
  return {
    id: "core.settings.connectors",
    async run(stores: HostStores, vaultId, raw, sessionCurrent = () => true) {
      const parsed = request.safeParse(raw);
      if (!parsed.success)
        return { status: "refused", reason: "invalid_input", preparation: "none" };
      const vault = stores.vaults.get(vaultId);
      const runtime = input.runtime();
      if (vault?.mode !== "native" || !runtime || !input.lock()?.held)
        return { status: "not_started", reason: "capability_unavailable" };
      const current = () =>
        sessionCurrent() &&
        stores.vaults.get(vaultId) === vault &&
        vault.native.isCurrent() &&
        input.lock()?.held === true;
      if (!current()) return { status: "refused", reason: "stale_action", preparation: "none" };
      const { catalog } = runtime;
      const action = parsed.data;
      const identity = JSON.stringify([vaultId, action]);
      const prior = unresolved.get(vaultId);
      if (prior)
        return prior.identity === identity
          ? prior.result
          : { status: "not_started", reason: "pending_previous_attempt" };
      if (mutationBusy) return { status: "not_started", reason: "pending_previous_attempt" };
      mutationBusy = true;
      const holder = () => current() && vault.native.canFetchPublicMarket();
      try {
        if (action.op === "approve") {
          catalog.approve(action.id, action.digest, action.interpreter, {
            ownerAction: true,
            isCurrent: current,
          });
          return { status: "completed", value: { ok: true } };
        }
        if (action.op === "disable") {
          catalog.disable(action.id, { ownerAction: true, isCurrent: current });
          return { status: "completed", value: { ok: true } };
        }
        if (action.op === "remove") {
          const lock = input.lock();
          if (!lock) return { status: "not_started", reason: "capability_unavailable" };
          return (input.remove ?? removeConnectorOwner)({
            stores,
            catalog,
            id: action.id,
            dataDir: input.dataDir,
            lock,
            now: input.now,
            isCurrent: current,
          });
        }
        if (action.op === "bind") {
          const loaded = catalog.installed(action.id);
          const interpreter = resolveInterpreter(loaded);
          catalog.approved(action.id, interpreter);
          const specs = loaded.manifest.fetch?.params ?? [];
          if (
            loaded.manifest.kind !== "fetch" ||
            Object.keys(action.params).some((key) => !specs.some((spec) => spec.id === key)) ||
            specs.some((spec) => spec.required && action.params[spec.id] === undefined) ||
            specs.some(
              (spec) =>
                action.params[spec.id] !== undefined &&
                typeof action.params[spec.id] !== (spec.type === "date" ? "string" : spec.type),
            )
          )
            return { status: "refused", reason: "invalid_params", preparation: "none" };
          const command = defineCommand({
            id: "connector.owner.bind",
            input: z.object({}),
            run(ctx) {
              if (
                !holder() ||
                !ctx.lease.isHolder() ||
                !validAccount(ctx, action.account, loaded.manifest.module)
              )
                return refuse("binding_unavailable");
              try {
                if (catalog.approved(action.id, interpreter).contentSha256 !== loaded.contentSha256)
                  return refuse("code_changed");
              } catch {
                return refuse("code_changed");
              }
              const gid = ctx.det("connector_bindings", [action.account, action.id]);
              ctx.emit("connectorBinding.set", gid, {
                account: action.account,
                connectorId: action.id,
                params: action.params,
                autoCommit: action.autoCommit,
              });
              return ok({ binding: gid });
            },
          });
          const result = input.execute
            ? await input.execute(vault, command, current)
            : await runHostVaultCommand(vault, command, {}, mintUlid(input.now()), current);
          if (result.kind === "outcome_unknown") {
            const unknown = unknownUiCommand(result, command.id);
            unresolved.set(vaultId, { identity, result: unknown });
            return unknown;
          }
          if (result.kind === "not_started")
            return { status: "not_started", reason: "capability_unavailable" };
          return result.kind === "completed"
            ? { status: "completed", value: result.value }
            : { status: "refused", reason: result.reason, preparation: "none" };
        }
        const row = bindingRow(vault, action.binding);
        if (!row) return { status: "refused", reason: "binding_unavailable", preparation: "none" };
        if (action.op === "unbind") {
          const command = defineCommand({
            id: "connector.owner.unbind",
            input: z.object({}),
            run(ctx) {
              const currentRow = ctx.read<BindingRow>(
                `SELECT b.gid, a.gid AS account, b.connector_id FROM connector_bindings b
                   JOIN accounts a ON a.id = b.account_id WHERE b.gid = ? AND a.removed_at IS NULL`,
                row.gid,
              )[0];
              if (
                !holder() ||
                !ctx.lease.isHolder() ||
                currentRow?.account !== row.account ||
                currentRow.connector_id !== row.connector_id
              )
                return refuse("binding_unavailable");
              ctx.emit("connectorBinding.removed", row.gid, {});
              return ok({ ok: true });
            },
          });
          const result = input.execute
            ? await input.execute(vault, command, current)
            : await runHostVaultCommand(vault, command, {}, mintUlid(input.now()), current);
          if (result.kind === "outcome_unknown") {
            const unknown = unknownUiCommand(result, command.id);
            unresolved.set(vaultId, { identity, result: unknown });
            return unknown;
          }
          if (result.kind === "not_started")
            return { status: "not_started", reason: "capability_unavailable" };
          return result.kind === "completed"
            ? { status: "completed", value: result.value }
            : { status: "refused", reason: result.reason, preparation: "none" };
        }
        if (action.op === "run") {
          const ownership = input.worker()?.ownership;
          const guard = () => {
            if (
              !holder() ||
              ownership?.isExclusive("connectors.fetch", vault) !== true ||
              bindingRow(vault, row.gid)?.connector_id !== row.connector_id
            )
              throw new Error("fetch_authority_unavailable");
          };
          guard();
          const endFetch = vault.native.beginFetch();
          if (!endFetch) return { status: "not_started", reason: "capability_unavailable" };
          let outcome: Awaited<ReturnType<typeof runtime.runOne>>;
          try {
            outcome = await runtime.runOne(vault, row.gid, guard);
          } finally {
            endFetch();
          }
          if (outcome.status === "ok") await reportSuccessfulFetch(vault, guard);
          return { status: "completed", value: outcome };
        }
        const loaded = catalog.installed(row.connector_id);
        const interpreter = resolveInterpreter(loaded);
        const params: unknown = JSON.parse(row.params_json);
        if (!params || typeof params !== "object" || Array.isArray(params) || !holder())
          return { status: "refused", reason: "binding_unavailable", preparation: "none" };
        const binding: ConnectorBinding = {
          id: row.gid,
          profileId: vaultId,
          accountId: row.account,
          connectorId: row.connector_id,
          module: loaded.manifest.module,
          enabled: true,
          params: params as Record<string, unknown>,
          cursor: row.cursor,
        };
        const fingerprint = {
          id: row.gid,
          profileId: vaultId,
          accountId: row.account,
          connectorId: row.connector_id,
          module: loaded.manifest.module,
          baseCursor: row.cursor,
          paramsDigest: bindingParamsDigest(params as Record<string, unknown>),
          approvedCodeDigest: loaded.contentSha256,
          interpreter,
        };
        const bindingCurrent = () =>
          connectorBindingMatches(
            vault.store.read.bind(vault.store),
            vaultId,
            fingerprint,
            catalog,
            holder,
          );
        if (!bindingCurrent())
          return { status: "refused", reason: "binding_unavailable", preparation: "none" };
        const lock = input.lock();
        if (!lock)
          return { status: "refused", reason: "capability_unavailable", preparation: "none" };
        const secrets = (input.makeSecrets ?? boundConnectorSecrets)({
          catalog,
          binding,
          interpreter,
          authority: {
            dataDir: input.dataDir,
            lock,
            isOwnerAction: current,
            isCurrent: (identity) =>
              current() &&
              holder() &&
              identity.profileId === vaultId &&
              identity.bindingId === row.gid &&
              bindingCurrent(),
          },
        });
        if (action.op === "setSecret") await secrets.set(action.secret, action.value);
        else await secrets.clear(action.secret);
        return { status: "completed", value: { ok: true } };
      } catch {
        return { status: "outcome_unknown", reason: "unexpected_failure" };
      } finally {
        mutationBusy = false;
      }
    },
  };
}
