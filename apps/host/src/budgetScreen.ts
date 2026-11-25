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
/** Committed outcomes kept per vault (without the file bytes) so a retried commit answers again. */
const MAX_COMMITTED = 8;

interface Stage {
  readonly vault: string;
  readonly request: StatementRequest;
  readonly sha256: string;
  readonly importer: string;
  readonly at: number;
  readonly key: string;
}

interface Committed {
  readonly vault: string;
  readonly at: number;
  readonly outcome: StatementCommitOutcome;
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
  /** Stage id -> its commit's outcome, kept up to the stage age limit after the stage is dropped. */
  const committed = new Map<string, Committed>();
  let closed = false;
  const bind = () =>
    closed
      ? null
      : { generation: "budget-statements", capabilities: null, isCurrent: () => !closed };
  /** Drops entries past the age limit and the oldest of `vault` beyond `max - 1` (room for one). */
  const pruneMap = <T extends { readonly vault: string; readonly at: number }>(
    map: Map<string, T>,
    vault: string,
    max: number,
  ) => {
    const now = options.now();
    for (const [id, entry] of map) if (now - entry.at > STAGE_MAX_AGE_MS) map.delete(id);
    const own = [...map.entries()].filter(([, entry]) => entry.vault === vault);
    for (const [id] of own.slice(0, Math.max(0, own.length - max + 1))) map.delete(id);
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
      pruneMap(stages, context.vault, MAX_STAGES);
      const id = randomUUID();
      stages.set(id, {
        vault: context.vault,
        request,
        sha256: result.preview.sha256,
        importer: result.preview.importer.id,
        at: options.now(),
        key: mintUlid(options.now()),
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
      const done = committed.get(input.stage);
      if (
        done !== undefined &&
        done.vault === context.vault &&
        options.now() - done.at <= STAGE_MAX_AGE_MS
      )
        return { status: "completed", value: done.outcome };
      const stage = stages.get(input.stage);
      if (
        stage === undefined ||
        stage.vault !== context.vault ||
        options.now() - stage.at > STAGE_MAX_AGE_MS
      )
        return { status: "completed", value: refusedWith("not_found") };
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
      const outcome: StatementCommitOutcome = {
        status: "committed",
        result: { ...value, ...facts },
      };
      stages.delete(input.stage);
      pruneMap(committed, context.vault, MAX_COMMITTED);
      committed.set(input.stage, { vault: context.vault, at: stage.at, outcome });
      return { status: "completed", value: outcome };
    },
  });

  return {
    actions: [preview, commit],
    close() {
      closed = true;
      stages.clear();
      committed.clear();
    },
  };
}
