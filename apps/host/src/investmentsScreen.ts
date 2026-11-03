/** Direct UI imports use only explicitly injected checked selection, staging, publication and holder. */
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@cashu/domain";
import { asAccountId } from "@cashu/domain/investments";
import { MAX_FILE_BYTES } from "@cashu/domain/investments/importing";
import { investmentsCommands as C, defineCommand, mintUlid, refuse } from "@cashu/store";
import {
  brokerageAccount,
  type ImportRequest,
  previewImport,
} from "@cashu/store/investments/queries";
import {
  type InvestmentCommitResult,
  type InvestmentPreviewResult,
  importCommitResultSchema,
  importPreviewForUi,
  investmentImportCommit,
  investmentImportPreview,
  investmentPreviewInputSchema,
} from "@cashu/store/investments/screen";
import {
  type ImportPublication,
  type ImportStaging,
  publishCheckedImportBlob,
} from "@cashu/store/investments/services";
import { canonicalAccountFilter } from "@cashu/store/investments/views";
import { z } from "zod";
import { defineUiAction, unknownUiCommand } from "./uiActions.js";

export interface InvestmentImportCapability {
  readonly vault: string;
  readonly generation: string;
  readonly staging: ImportStaging;
  readonly publication: ImportPublication;
  /** Chooses through a genuine checked picker, or resolves a host-issued selected-file handle. */
  select(
    selection?: string,
  ): Promise<{ readonly name: string; readonly content: Uint8Array } | null>;
  isCurrent(): boolean;
  isHolder(vault: string): boolean;
}
interface Stage {
  readonly vault: string;
  readonly generation: string;
  readonly capability: InvestmentImportCapability;
  readonly request: ImportRequest;
  readonly hash: string;
  readonly key: string;
  corrections: readonly string[] | null;
  archive: { readonly sha256: string; readonly ext: string } | null;
  committed: InvestmentCommitResult | null;
}
const commitInput = z.strictObject({
  stage: z.string().min(1).max(100),
  corrections: z.array(z.string().max(200)).max(10000).default([]),
});
const { archiveExtension, commitImport } = C;

export function investmentImportActions(options: {
  bind(vault: string): InvestmentImportCapability | null;
  now(): number;
}) {
  const stages = new Map<string, Stage>();
  const pendingPreviews = new Map<string, number>();
  let closed = false;
  const binding = (vault: string) => {
    const capability = options.bind(vault);
    if (closed || capability === null || capability.vault !== vault || !capability.isCurrent())
      return null;
    return {
      generation: capability.generation,
      capabilities: capability,
      isCurrent: () => !closed && capability.isCurrent() && options.bind(vault) === capability,
    };
  };
  const preparedCommit = defineCommand({
    id: "investments.desktop.commitPreparedImport",
    input: commitInput,
    run(ctx, input) {
      const stage = stages.get(input.stage);
      if (
        stage === undefined ||
        stage.vault !== ctx.vault ||
        !stage.capability.isCurrent() ||
        stage.archive === null ||
        !stage.capability.isHolder(ctx.vault)
      )
        return refuse("stale_import");
      const account = brokerageAccount(ctx.read, stage.request.account);
      if (account === undefined || account.removed) return refuse("no_account");
      if (sha256Hex(stage.request.file.content) !== stage.hash)
        return refuse("staged_file_changed");
      if (JSON.stringify(stage.corrections) !== JSON.stringify(input.corrections))
        return refuse("changed_corrections");
      return commitImport.run(
        {
          ...ctx,
          lease: {
            isHolder: () => stage.capability.isCurrent() && stage.capability.isHolder(ctx.vault),
          },
        },
        commitImport.input.parse({
          ...stage.request,
          corrections: input.corrections,
          archive: stage.archive,
        }),
      );
    },
  });
  const preview = defineUiAction<
    z.infer<typeof investmentPreviewInputSchema>,
    InvestmentImportCapability,
    InvestmentPreviewResult
  >({
    id: investmentImportPreview.id,
    module: "investments",
    input: investmentPreviewInputSchema,
    bind: binding,
    async run(context, input) {
      if (
        [...stages.values()].filter(
          (stage) => stage.vault === context.vault && stage.committed === null,
        ).length +
          (pendingPreviews.get(context.vault) ?? 0) >=
        8
      )
        return { status: "refused", reason: "busy", preparation: "none" };
      pendingPreviews.set(context.vault, (pendingPreviews.get(context.vault) ?? 0) + 1);
      try {
        for (const [key, stage] of stages)
          if (stage.vault === context.vault && stage.committed !== null) stages.delete(key);
        const account = await context.readStep((read) => {
          const filter = canonicalAccountFilter(read, [asAccountId(input.account)]);
          const root = filter.ok ? filter.accounts?.[0] : undefined;
          return root === undefined ? undefined : brokerageAccount(read, root);
        });
        if (account === undefined || account.removed)
          return { status: "refused", reason: "no_account", preparation: "none" };
        const selected = await context.capabilities.select(input.selection);
        if (selected === null)
          return { status: "completed", value: { status: "cancelled" as const } };
        if (!context.isCurrent())
          return { status: "refused", reason: "stale_import", preparation: "none" };
        if (selected.content.length === 0 || selected.content.length > MAX_FILE_BYTES)
          return { status: "refused", reason: "invalid_file_size", preparation: "none" };
        const request: ImportRequest = {
          account: account.gid,
          file: { name: selected.name, content: Uint8Array.from(selected.content) },
          ...(input.importer === undefined ? {} : { importer: input.importer }),
          ...(input.mappingYaml === undefined ? {} : { mappingYaml: input.mappingYaml }),
        };
        const result = await context.readStep((read) =>
          previewImport(read, request, new Date(options.now()).toISOString()),
        );
        if (!result.ok) return { status: "refused", reason: result.reason, preparation: "none" };
        const dto = importPreviewForUi(result.preview);
        if (!result.preview.canCommit)
          return { status: "completed", value: { status: "blocked" as const, preview: dto } };
        await context.capabilities.staging.put(
          result.preview.sha256,
          archiveExtension(request.file.name),
          Uint8Array.from(request.file.content),
        );
        if (!context.isCurrent())
          return { status: "refused", reason: "stale_import", preparation: "retained" };
        const id = randomUUID();
        stages.set(id, {
          vault: context.vault,
          generation: context.generation,
          capability: context.capabilities,
          request,
          hash: result.preview.sha256,
          key: mintUlid(options.now()),
          corrections: null,
          archive: null,
          committed: null,
        });
        return {
          status: "completed",
          value: { status: "previewed" as const, stage: id, preview: dto },
        };
      } finally {
        const remaining = (pendingPreviews.get(context.vault) ?? 1) - 1;
        if (remaining === 0) pendingPreviews.delete(context.vault);
        else pendingPreviews.set(context.vault, remaining);
      }
    },
  });
  const commit = defineUiAction<
    z.infer<typeof commitInput>,
    InvestmentImportCapability,
    InvestmentCommitResult
  >({
    id: investmentImportCommit.id,
    module: "investments",
    input: commitInput,
    bind: binding,
    commands: [preparedCommit],
    async run(context, input) {
      const stage = stages.get(input.stage);
      if (
        stage === undefined ||
        stage.vault !== context.vault ||
        stage.generation !== context.generation ||
        stage.capability !== context.capabilities
      )
        return { status: "refused", reason: "no_staged_file", preparation: "none" };
      if (stage.committed !== null) return { status: "completed", value: stage.committed };
      if (!context.capabilities.isHolder(context.vault))
        return { status: "refused", reason: "not_leader", preparation: "retained" };
      const ext = archiveExtension(stage.request.file.name);
      const staged = await context.capabilities.staging.get(stage.hash, ext);
      if (
        !context.isCurrent() ||
        staged === null ||
        staged.length > MAX_FILE_BYTES ||
        sha256Hex(staged) !== stage.hash ||
        staged.length !== stage.request.file.content.length ||
        staged.some((byte, index) => byte !== stage.request.file.content[index])
      )
        return { status: "refused", reason: "staged_file_changed", preparation: "retained" };
      const checked = await context.readStep((read) =>
        previewImport(read, stage.request, new Date(options.now()).toISOString()),
      );
      if (!checked.ok || !checked.preview.canCommit)
        return { status: "refused", reason: "cannot_commit", preparation: "retained" };
      if (
        stage.corrections !== null &&
        JSON.stringify(stage.corrections) !== JSON.stringify(input.corrections)
      )
        return { status: "refused", reason: "changed_corrections", preparation: "retained" };
      stage.corrections = [...input.corrections];
      const published = await publishCheckedImportBlob(
        context.capabilities.publication,
        context.vault,
        stage.request.file,
      );
      stage.archive = published.blob;
      const result = await context.execute({ command: preparedCommit.id, input, key: stage.key });
      if (result.kind === "outcome_unknown") return unknownUiCommand(result, preparedCommit.id);
      if (result.kind === "not_started")
        return { status: "not_started", reason: "capability_unavailable" };
      if (result.kind === "refused")
        return {
          status: "completed",
          value: {
            status: "refused" as const,
            reason: result.reason,
            preparation: "retained" as const,
          },
        };
      const committed = importCommitResultSchema.safeParse(result.value);
      if (!committed.success)
        return {
          status: "completed",
          value: { status: "recovery_required" as const, reason: "committed_result_unavailable" },
        };
      // Hash-addressed preview staging can be shared by another consumer. Leave it to existing prune.
      stage.committed = {
        status: "committed",
        result: committed.data,
        stagingCleanup: "retained",
        publicationCleanupFailed: published.cleanupFailed,
      };
      return { status: "completed", value: stage.committed };
    },
  });
  return {
    actions: [preview, commit],
    close() {
      closed = true;
      stages.clear();
    },
  };
}
