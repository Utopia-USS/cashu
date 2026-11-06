/** The budget statement import drawer's actions (Python POST /budget/import/preview + /commit). */
import { randomUUID } from "node:crypto";
import { type Command, mintUlid } from "@cashu/store";
import {
  batchCategorized,
  budgetStatementCommit,
  budgetStatementPreview,
  commitStatementImport,
  previewStatement,
  STATEMENT_MAX_BYTES,
  type StatementCommitOutcome,
  type StatementCommitResult,
  type StatementPreviewInput,
  type StatementPreviewResult,
  type StatementRequest,
  statementContentBytes,
  statementPreviewInputSchema,
  transferPairCount,
} from "@cashu/store/budget/queries";
import { z } from "zod";
import { defineUiAction, unknownUiCommand } from "./uiActions.js";

/** Python STAGING_MAX_AGE: an abandoned preview is never kept longer than a day. */
const STAGE_MAX_AGE_MS = 24 * 3600 * 1000;
/** Open previews per vault; the oldest goes first. */
const MAX_STAGES = 8;

interface Stage {
  readonly vault: string;
  readonly request: StatementRequest;
  readonly sha256: string;
  readonly importer: string;
  readonly at: number;
  readonly key: string;
  committed: StatementCommitOutcome | null;
}

const commitInput = z.strictObject({ stage: z.string().min(1).max(100) });
type Refused = {
  readonly status: "refused";
  readonly code: string;
  readonly detail: string | null;
};
const refusedWith = (code: string, detail: string | null = null): Refused => ({
  status: "refused",
  code,
  detail,
});

/**
 * Preview stages the picked file's bytes in memory (the Python staging file's role, `stage` = its
 * handle); commit re-reads them through the vault command and answers the done step's counts.
 * Transfer pairs and categories are derived after the append, read back once it completed.
 */
export function budgetStatementActions(options: { now(): number }) {
  const stages = new Map<string, Stage>();
  let closed = false;
  const bind = () =>
    closed
      ? null
      : { generation: "budget-statements", capabilities: null, isCurrent: () => !closed };
  const prune = (vault: string) => {
    const now = options.now();
    for (const [id, stage] of stages)
      if (now - stage.at > STAGE_MAX_AGE_MS || stage.committed !== null) stages.delete(id);
    const own = [...stages.entries()].filter(([, stage]) => stage.vault === vault);
    for (const [id] of own.slice(0, Math.max(0, own.length - MAX_STAGES + 1))) stages.delete(id);
  };

  const preview = defineUiAction<StatementPreviewInput, null, StatementPreviewResult>({
    id: budgetStatementPreview.id,
    module: "budget",
    input: statementPreviewInputSchema,
    bind,
    async run(context, input) {
      const content = statementContentBytes(input.content);
      if (content.length === 0)
        return { status: "completed", value: refusedWith("import_empty", "The file is empty") };
      if (content.length > STATEMENT_MAX_BYTES)
        return { status: "completed", value: refusedWith("file_too_large") };
      const fileName =
        input.fileName.replace(/\\/g, "/").split("/").pop()?.slice(0, 200) || "wyciag.csv";
      const request: StatementRequest = {
        fileName,
        content,
        lang: input.lang,
        ...(input.importer === undefined ? {} : { importer: input.importer }),
        ...(input.accountType === undefined ? {} : { accountType: input.accountType }),
        ...(input.accountName == null ? {} : { accountName: input.accountName.trim() || null }),
        ...(input.account === undefined ? {} : { account: input.account }),
      };
      const result = await context.readStep((read) => previewStatement(read, request));
      if (!result.ok)
        return { status: "completed", value: refusedWith(result.code, result.detail) };
      if (!context.isCurrent())
        return { status: "refused", reason: "stale_import", preparation: "none" };
      prune(context.vault);
      const id = randomUUID();
      stages.set(id, {
        vault: context.vault,
        request,
        sha256: result.preview.sha256,
        importer: result.preview.importer.id,
        at: options.now(),
        key: mintUlid(options.now()),
        committed: null,
      });
      return {
        status: "completed",
        value: { status: "previewed", stage: id, preview: result.preview },
      };
    },
  });

  const commit = defineUiAction<z.infer<typeof commitInput>, null, StatementCommitOutcome>({
    id: budgetStatementCommit.id,
    module: "budget",
    input: commitInput,
    bind,
    commands: [commitStatementImport as Command<unknown, unknown>],
    async run(context, input) {
      const stage = stages.get(input.stage);
      if (
        stage === undefined ||
        stage.vault !== context.vault ||
        options.now() - stage.at > STAGE_MAX_AGE_MS
      )
        return { status: "completed", value: refusedWith("not_found") };
      if (stage.committed !== null) return { status: "completed", value: stage.committed };
      const before = await context.readStep(transferPairCount);
      const { request } = stage;
      const result = await context.execute({
        command: commitStatementImport.id,
        input: {
          fileName: request.fileName,
          content: request.content,
          sha256: stage.sha256,
          importer: stage.importer,
          lang: request.lang,
          ...(request.accountType === undefined ? {} : { accountType: request.accountType }),
          ...(request.accountName == null ? {} : { accountName: request.accountName }),
          ...(request.account === undefined ? {} : { account: request.account }),
        },
        key: stage.key,
      });
      if (result.kind === "outcome_unknown")
        return unknownUiCommand(result, commitStatementImport.id);
      if (result.kind === "not_started")
        return { status: "not_started", reason: "capability_unavailable" };
      if (result.kind === "refused")
        return { status: "completed", value: refusedWith(result.reason) };
      const value = result.value as StatementCommitResult;
      const facts = await context.readStep((read) => ({
        categorized: batchCategorized(read, value.batch),
        transferPairs: Math.max(0, transferPairCount(read) - before),
      }));
      stage.committed = { status: "committed", result: { ...value, ...facts } };
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
