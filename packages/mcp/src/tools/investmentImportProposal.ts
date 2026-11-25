/**
 * Checked file read (or rows typed in from chat) and durable blob publication surround fresh native
 * import previews.
 */
import { pyCasefold, pyStrip, sha256Hex } from "@cashu/domain";
import { MAX_FILE_BYTES } from "@cashu/domain/investments/importing";
import { mcpAccounts, mcpProfile } from "@cashu/store/core";
import {
  brokerageAccounts,
  type ImportPreview,
  type ImportRequest,
  isConnectorChoice,
  previewImport,
} from "@cashu/store/investments/queries";
import {
  createInvestmentImportProposal,
  type ImportProposalPreview,
  type ImportPublication,
  investmentImportSummary,
  publishCheckedImportBlob,
} from "@cashu/store/investments/services";
import * as L from "../privacy/labels.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import {
  type NativeAsyncAdapter,
  type NativeAsyncIo,
  type NativeAsyncStep,
  type NativeAsyncValue,
  type NativePreparationStore,
  ownedValue,
} from "../runtime/async.js";
import { object, text } from "./investmentAsyncData.js";
import { byKind, refuseScript } from "./investmentsImport.js";
import {
  canonicalRows,
  ROWS_FILE_NAME,
  rowsDocument,
  rowsSource,
} from "./investmentTransactionRows.js";
import { execute, reference } from "./investmentWriteSupport.js";
import * as F from "./researchLabels.js";

type Context = ToolContext<NativePreparationStore>;
interface ImportIo extends NativeAsyncIo {
  readonly publication: ImportPublication;
  readonly profileSlug: string;
  readonly readFile: NativePreparationStore["readInvestmentImportFile"];
  readonly readMapping: NativePreparationStore["readInvestmentMappingFile"];
}
/** The brokerage account an import names (generated label or `account:` reference). */
export function account(ctx: Context, args: ToolArgs) {
  const value = typeof args.account === "string" ? pyStrip(args.account) : "";
  const labels = new Map(
    mcpAccounts(ctx.store.read).map((row) => [row.gid, ctx.accountLabels.get(row.id)]),
  );
  const wanted = value.startsWith("account:") ? reference("account", value) : null;
  const row = brokerageAccounts(ctx.store.read).find(
    (a) =>
      wanted === a.gid ||
      (wanted === null &&
        value !== "" &&
        pyCasefold(labels.get(a.gid) ?? "") === pyCasefold(value)),
  );
  if (!row)
    throw new ToolError(
      "no such brokerage account; use accounts[].account_id from portfolio_overview",
      "not_found",
    );
  const label = labels.get(row.gid);
  if (!label) throw new Error("native brokerage account label missing");
  return { gid: row.gid, label, bank: row.bank };
}
function ioOf(ctx: Context, needsFile = true): ImportIo {
  const all = ctx.store.investmentAsync,
    publication = all?.imports;
  const vault = ctx.profileId.toString(16).padStart(32, "0");
  if (all && (all.vault !== vault || (publication && publication.vault !== vault)))
    throw new Error("import publication vault mismatch");
  if (!publication?.isCurrent())
    throw new ToolError("checked encrypted import publication is unavailable", "unsupported");
  const readFile = ctx.store.readInvestmentImportFile;
  if (needsFile && !readFile)
    throw new ToolError("local file validation is unavailable", "unsupported");
  const profile = mcpProfile(ctx.store.read);
  if (!profile)
    throw new ToolError("the profile of this server no longer exists", "profile_missing", {
      system: true,
    });
  // Host readers are explicitly bound to immutable slug + checked I/O functions, not a context.
  return Object.freeze({
    vault,
    binding: publication.binding,
    isCurrent: publication.isCurrent.bind(publication),
    publication,
    profileSlug: profile.slug,
    readFile,
    readMapping: ctx.store.readInvestmentMappingFile,
  });
}
function validate(ctx: Context, args: ToolArgs) {
  const path = typeof args.path === "string" ? args.path : "",
    mapping = typeof args.mapping === "string" ? args.mapping : undefined;
  refuseScript(path, "path");
  refuseScript(mapping, "mapping");
  // A connector's import is proposed by its own run, never by the agent with a connector importer.
  if (isConnectorChoice(typeof args.importer === "string" ? args.importer : null))
    throw new ToolError("connector imports are proposed by the connector run", "unsupported");
  const selected = account(ctx, args),
    io = ioOf(ctx);
  const candidate = pyStrip(mapping ?? "");
  if (candidate && !candidate.includes("\n") && /\.ya?ml$/iu.test(candidate) && !io.readMapping)
    throw new ToolError("local mapping files are unavailable", "unsupported");
  return { path, mapping: mapping ?? null, selected, io };
}
function request(
  state: Readonly<Record<string, NativeAsyncValue>>,
  selected: string,
  importer: unknown,
): ImportRequest {
  if (!(state.bytes instanceof Uint8Array) || state.bytes.length > MAX_FILE_BYTES)
    throw new Error("invalid import bytes");
  if (text(state.account) !== selected)
    throw new ToolError("the brokerage account changed while preparing; propose again", "conflict");
  return {
    account: selected,
    file: { name: text(state.fileName), content: Uint8Array.from(state.bytes) },
    mappingYaml: state.mappingYaml === null ? null : text(state.mappingYaml),
    importer: typeof importer === "string" ? importer : "auto",
  };
}
export function preview(ctx: Context, input: ImportRequest): ImportPreview {
  const out = previewImport(ctx.store.read, input, new Date(ctx.store.now()).toISOString());
  if (!out.ok)
    throw new ToolError(
      out.reason === "no_account" ? "no such brokerage account" : "file is too large",
    );
  return out.preview;
}
export function labelled(pv: ImportProposalPreview): L.LabelledTree {
  const result: Record<string, L.LabelledTree> = {};
  for (const [key, value] of Object.entries(pv.summary))
    result[key] =
      typeof value === "boolean"
        ? L.flag(value)
        : typeof value === "number"
          ? L.count(value)
          : L.category(value);
  result.warnings_by_kind = byKind(pv.warnings);
  result.errors_by_kind = byKind(pv.errors);
  return result;
}
const blocked = (pv: ImportProposalPreview) => ({
  stored: L.flag(false),
  preview: labelled(pv),
  note: L.text("not stored: the preview has blocking errors (by kind above)"),
});
export const investmentImportAdapter: NativeAsyncAdapter = {
  name: "propose_import",
  maxIoPhases: 2,
  current(ctx, previous) {
    const io = ioOf(ctx);
    return (
      io.binding === previous.binding &&
      io.profileSlug === (previous as ImportIo).profileSlug &&
      io.isCurrent()
    );
  },
  advance(ctx, args, resume): NativeAsyncStep {
    const { path, mapping, selected, io } = validate(ctx, args);
    if (resume === undefined)
      return { kind: "io", io, operation: { kind: "read", path, mapping, account: selected.gid } };
    const state = object(resume),
      input = request(state, selected.gid, args.importer),
      pv = preview(ctx, input);
    if (state.kind === "published" || !pv.canCommit) return { kind: "ready", ready: resume };
    return { kind: "io", io, operation: { kind: "publish", state: resume } };
  },
  async perform(raw, base, signal, warn) {
    const io = base as ImportIo,
      operation = object(raw);
    if (operation.kind === "read") {
      if (!io.readFile) throw new Error("checked file reader unavailable");
      const file = io.readFile(text(operation.path));
      const bytes = Uint8Array.from(file.bytes);
      if (bytes.length > MAX_FILE_BYTES) throw new Error("import file too large");
      let mappingYaml: string | null = operation.mapping === null ? null : text(operation.mapping);
      const candidate = pyStrip(mappingYaml ?? "");
      if (!candidate) mappingYaml = null;
      else if (!candidate.includes("\n") && /\.ya?ml$/iu.test(candidate)) {
        if (!io.readMapping) throw new Error("checked mapping reader unavailable");
        mappingYaml = await io.readMapping(candidate);
      }
      return ownedValue({
        kind: "read",
        fileName: file.name,
        bytes,
        mappingYaml,
        account: text(operation.account),
      });
    }
    if (operation.kind !== "publish") throw new Error("invalid import operation");
    const state = object(operation.state ?? null);
    if (!(state.bytes instanceof Uint8Array)) throw new Error("invalid publication bytes");
    const published = await publishCheckedImportBlob(
      io.publication,
      io.vault,
      { name: text(state.fileName), content: state.bytes },
      signal,
    );
    if (published.cleanupFailed) warn("mcp.import-stage-cleanup-failed");
    return ownedValue({ ...state, kind: "published", blob: published.blob });
  },
  async finish(ctx, args, ready) {
    const { selected, io } = validate(ctx, args),
      state = object(ready),
      input = request(state, selected.gid, args.importer);
    if (state.kind !== "published") {
      const pv = preview(ctx, input);
      if (pv.canCommit)
        throw new ToolError("the preview changed while preparing; propose again", "conflict");
      return {
        answer: blocked({
          summary: investmentImportSummary(pv),
          warnings: pv.warnings,
          errors: pv.errors,
        }),
      };
    }
    const blob = object(state.blob ?? null);
    const saved = await execute(
      ctx,
      createInvestmentImportProposal(
        io.publication,
        input,
        { sha256: text(blob.sha256), ext: text(blob.ext) },
        selected.label,
      ),
      { reason: args.reason ?? null },
    );
    if (!saved.stored) return { answer: blocked(saved.preview) };
    return {
      answer: {
        stored: L.flag(true),
        proposal_id: F.ref("proposal", saved.proposalGid),
        account: L.account(selected.label),
        file: L.identifier(input.file.name),
        preview: labelled(saved.preview),
        note: L.text("stored as a pending import; the owner reviews and commits it in the app"),
      },
    };
  },
};
/** The rows of `propose_transactions` as the document an import of them reads (no file access). */
function rowsInput(ctx: Context, args: ToolArgs) {
  const rows = canonicalRows(args.rows),
    selected = account(ctx, args),
    io = ioOf(ctx, false),
    file = rowsDocument(rows, rowsSource(args, selected.bank));
  return { selected, io, file, rows: rows.length };
}
export const answerPreview = (pv: ImportPreview): ImportProposalPreview => ({
  summary: investmentImportSummary(pv),
  warnings: pv.warnings,
  errors: pv.errors,
});
/** A pending import proposal of the very same document into the same account, if any. */
function pendingTwin(ctx: Context, account: string, content: Uint8Array): string | null {
  const rows = ctx.store.read<{ gid: string }>(
    `SELECT gid FROM proposals WHERE kind = 'import' AND status = 'pending'
       AND json_extract(payload, '$.account') = ? AND json_extract(payload, '$.file_sha256') = ?
     ORDER BY id LIMIT 1`,
    account,
    sha256Hex(content),
  );
  return rows[0]?.gid ?? null;
}
const nothingNew = (pv: ImportProposalPreview) => ({
  stored: L.flag(false),
  preview: labelled(pv),
  note: L.text("not stored: every row is already in this account (all duplicates)"),
});
const twinAnswer = (gid: string) => ({
  stored: L.flag(false),
  proposal_id: F.ref("proposal", gid),
  note: L.text(
    "not stored: the same rows already wait as a pending import for the owner to commit in the app",
  ),
});
/**
 * `propose_transactions`: rows typed in from chat, published as a canonical `cashu-import` JSON
 * document and proposed exactly like `propose_import` (same preview, dedup and owner approval).
 */
export const investmentTransactionsAdapter: NativeAsyncAdapter = {
  name: "propose_transactions",
  maxIoPhases: 1,
  current(ctx, previous) {
    const io = ioOf(ctx, false);
    return (
      io.binding === previous.binding &&
      io.profileSlug === (previous as ImportIo).profileSlug &&
      io.isCurrent()
    );
  },
  perform: investmentImportAdapter.perform,
  advance(ctx, args, resume): NativeAsyncStep {
    const { selected, io, file } = rowsInput(ctx, args);
    if (resume !== undefined) {
      const state = object(resume);
      if (state.kind !== "published") throw new Error("invalid rows import state");
      return { kind: "ready", ready: resume };
    }
    const state = ownedValue({
      kind: "read",
      fileName: file.name,
      bytes: file.bytes,
      mappingYaml: null,
      account: selected.gid,
    });
    const pv = preview(ctx, request(object(state), selected.gid, "cashu"));
    if (
      !pv.canCommit ||
      investmentImportSummary(pv).new === 0 ||
      pendingTwin(ctx, selected.gid, file.bytes) !== null
    )
      return { kind: "ready", ready: state };
    return { kind: "io", io, operation: { kind: "publish", state } };
  },
  async finish(ctx, args, ready) {
    const { selected, io, file, rows } = rowsInput(ctx, args),
      state = object(ready),
      input = request(state, selected.gid, "cashu");
    if (
      input.file.name !== ROWS_FILE_NAME ||
      sha256Hex(input.file.content) !== sha256Hex(file.bytes)
    )
      throw new ToolError("the rows changed while preparing; propose again", "conflict");
    const twin = pendingTwin(ctx, selected.gid, file.bytes);
    if (twin !== null) return { answer: twinAnswer(twin) };
    const pv = answerPreview(preview(ctx, input));
    if (pv.errors.length > 0 || !pv.summary.can_commit) return { answer: blocked(pv) };
    if (pv.summary.new === 0) return { answer: nothingNew(pv) };
    if (state.kind !== "published")
      throw new ToolError("the preview changed while preparing; propose again", "conflict");
    const blob = object(state.blob ?? null);
    const saved = await execute(
      ctx,
      createInvestmentImportProposal(
        io.publication,
        input,
        { sha256: text(blob.sha256), ext: text(blob.ext) },
        selected.label,
      ),
      { reason: args.reason ?? null },
    );
    if (!saved.stored) return { answer: blocked(saved.preview) };
    return {
      answer: {
        stored: L.flag(true),
        proposal_id: F.ref("proposal", saved.proposalGid),
        account: L.account(selected.label),
        rows: L.count(rows),
        preview: labelled(saved.preview),
        note: L.text(
          "stored as a pending import; the owner reviews and commits it in the app. Do not also import a broker export covering these dates into this account: typed-in rows have no broker id, so the export's rows would not be recognised as duplicates",
        ),
      },
    };
  },
};
/** Synchronous callers cannot pretend publication finished; actual runtime registers the adapter. */
export function proposeInvestmentImport(): never {
  throw new ToolError("native async import publication is unavailable", "unsupported");
}
