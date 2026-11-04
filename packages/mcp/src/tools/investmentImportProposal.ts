/** Checked file read and durable blob publication surround fresh native import previews. */
import { pyCasefold, pyStrip } from "@cashu/domain";
import { MAX_FILE_BYTES } from "@cashu/domain/investments/importing";
import { mcpAccounts, mcpProfile } from "@cashu/store/core";
import {
  brokerageAccounts,
  type ImportPreview,
  type ImportRequest,
  previewImport,
} from "@cashu/store/investments/queries";
import {
  createInvestmentImportProposal,
  type ImportPublication,
  type ImportProposalPreview,
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
import { execute, reference } from "./investmentWriteSupport.js";
import * as F from "./researchLabels.js";

type Context = ToolContext<NativePreparationStore>;
interface ImportIo extends NativeAsyncIo {
  readonly publication: ImportPublication;
  readonly profileSlug: string;
  readonly readFile: NonNullable<NativePreparationStore["readInvestmentImportFile"]>;
  readonly readMapping: NativePreparationStore["readInvestmentMappingFile"];
}
function account(ctx: Context, args: ToolArgs) {
  const value = typeof args.account === "string" ? pyStrip(args.account) : "";
  const labels = new Map(
    mcpAccounts(ctx.store.read).map((row) => [row.gid, ctx.accountLabels.get(row.id)]),
  );
  const wanted = value.startsWith("account:") ? reference("account", value) : null;
  const row = brokerageAccounts(ctx.store.read).find(
    (a) =>
      wanted === a.gid ||
      (wanted === null && pyCasefold(labels.get(a.gid) ?? "") === pyCasefold(value)),
  );
  if (!row)
    throw new ToolError(
      "no such brokerage account; use the account label or id from portfolio_overview",
      "not_found",
    );
  const label = labels.get(row.gid);
  if (!label) throw new Error("native brokerage account label missing");
  return { gid: row.gid, label };
}
function ioOf(ctx: Context): ImportIo {
  const all = ctx.store.investmentAsync,
    publication = all?.imports;
  const vault = ctx.profileId.toString(16).padStart(32, "0");
  if (all && (all.vault !== vault || (publication && publication.vault !== vault)))
    throw new Error("import publication vault mismatch");
  if (!publication?.isCurrent())
    throw new ToolError("checked encrypted import publication is unavailable", "unsupported");
  const readFile = ctx.store.readInvestmentImportFile;
  if (!readFile) throw new ToolError("local file validation is unavailable", "unsupported");
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
  args: ToolArgs,
): ImportRequest {
  if (!(state.bytes instanceof Uint8Array) || state.bytes.length > MAX_FILE_BYTES)
    throw new Error("invalid import bytes");
  if (text(state.account) !== selected)
    throw new ToolError("the brokerage account changed while preparing; propose again", "conflict");
  return {
    account: selected,
    file: { name: text(state.fileName), content: Uint8Array.from(state.bytes) },
    mappingYaml: state.mappingYaml === null ? null : text(state.mappingYaml),
    importer: typeof args.importer === "string" ? args.importer : "auto",
  };
}
function preview(ctx: Context, input: ImportRequest): ImportPreview {
  const out = previewImport(ctx.store.read, input, new Date(ctx.store.now()).toISOString());
  if (!out.ok)
    throw new ToolError(
      out.reason === "no_account" ? "no such brokerage account" : "file is too large",
    );
  return out.preview;
}
function labelled(pv: ImportProposalPreview): L.LabelledTree {
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
      input = request(state, selected.gid, args),
      pv = preview(ctx, input);
    if (state.kind === "published" || !pv.canCommit) return { kind: "ready", ready: resume };
    return { kind: "io", io, operation: { kind: "publish", state: resume } };
  },
  async perform(raw, base, signal, warn) {
    const io = base as ImportIo,
      operation = object(raw);
    if (operation.kind === "read") {
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
      input = request(state, selected.gid, args);
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
/** Synchronous callers cannot pretend publication finished; actual runtime registers the adapter. */
export function proposeInvestmentImport(): never {
  throw new ToolError("native async import publication is unavailable", "unsupported");
}
