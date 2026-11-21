// The in-app statement import (Python `modules/budget/imports.py`, ab24ab6): a read-only preview of a
// picked file (importer, target account, new / duplicate / overlap rows, earlier imports) and the
// commit command that writes it through `importStatement` (the path `import-csv` uses). The file
// bytes travel in the command input; nothing is kept on disk. Transfer matching and categories are
// derived after the append (derivers), so the commit itself emits no matcher run.
//
// Importers (`importer`): `auto` (a cashU format document, else the bank whose CSV signature matches
// best), a bank id with a CSV parser, `cashu-budget` (docs/budget-import-format.md). Connectors are
// not offered here. A document goes through the newest-day rule (rows covered by stored history from
// another source are `overlap`), a built-in bank CSV keeps the plain dedup.
//
// Account resolution follows the native identity rules (`ensureAccount`): an account number names
// its account across banks (Python matched a bank CSV within its bank); a statement without a number
// goes to the account `import:<name key>` of its bank. `account` picks an existing bank account.
import {
  core,
  type Decimal,
  ibanKey,
  normalizeIban,
  normalizeText,
  sha256Hex,
} from "@cashu/domain";
import {
  BUDGET_IMPORTER_ID,
  type BudgetIssue,
  detectBank,
  issueCode,
  LEGACY_BUDGET_IMPORTER_ID,
  looksLikeBudgetDocument,
  type ParsedStatement,
  parseBudgetDocument,
  parseStatementFile,
  planImport,
  type RowStatus,
} from "@cashu/domain/budget";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../command.js";
import { accountByExternalKey, accountByGid, accountByIbanKey } from "../core/queries.js";
import { gid } from "../events/v1/primitives.js";
import type { Read } from "../query.js";
import type { UiAction } from "../ui-actions.js";
import { importStatement } from "./commands.js";
import { storedTxnsOfAccount } from "./queries.js";

/** The largest statement the app takes. Python took 20 MiB; the bytes cross the 16 MiB store
 * channel frame base64-encoded, so the app stops at 10 MiB (bank exports are a few hundred KiB). */
export const STATEMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Preview rows sent to the drawer (Python SAMPLE_ROWS). */
const SAMPLE_ROWS = 50;
const AUTO = "auto";
/** Account types a statement account can get, and the types of an account it may go into. */
export const STATEMENT_ACCOUNT_TYPES = ["checking", "savings", "credit"] as const;
const registry = core.builtinRegistry();

type StatementLang = "pl" | "en";
type StatementProblem =
  | "import_bank_unknown"
  | "import_file_format"
  | "import_header_missing"
  | "import_empty"
  | "import_invalid"
  | "import_account_type"
  | "import_account_mismatch"
  | "import_currency_mismatch"
  | "not_found";

/** A refusal with a stable code (the drawer's `error.<code>` label) and an English, value-free detail. */
export interface StatementRefusal {
  readonly ok: false;
  readonly code: StatementProblem;
  readonly detail: string | null;
}
const problem = (code: StatementProblem, detail: string | null = null): StatementRefusal => ({
  ok: false,
  code,
  detail,
});

interface Converted {
  readonly statement: ParsedStatement;
  /** The id the commit sends back: a bank id or `cashu-budget`. */
  readonly importer: string;
  readonly detected: boolean;
  readonly warnings: readonly BudgetIssue[];
  /** A document: matched by account number across banks, currency checked, newest-day rule. */
  readonly document: boolean;
}

/** Python `normalized_choice`. */
function choiceOf(importer: string | null | undefined): string {
  const choice = (importer ?? "").trim().toLowerCase();
  if (choice === LEGACY_BUDGET_IMPORTER_ID) return BUDGET_IMPORTER_ID;
  return choice || AUTO;
}

function fromDocument(
  content: Uint8Array,
  fileName: string,
  detected: boolean,
): Converted | StatementRefusal {
  const result = parseBudgetDocument(content, fileName, { registry: registry.institutions });
  const blocking = result.issues.filter((i) => i.blocking);
  if (result.statement === null || blocking.length > 0) {
    const shown = blocking
      .slice(0, 5)
      .map(
        (i) =>
          `${i.row === null ? "" : `row ${i.row}: `}${i.field === null ? "" : `${i.field}: `}${i.message}`,
      )
      .join("; ");
    const more = blocking.length > 5 ? ` (+${blocking.length - 5} more)` : "";
    return problem("import_invalid", `The document is not valid: ${shown}${more}`);
  }
  const stmt = result.statement;
  if (!stmt.transactions.length && !stmt.closingBalances.length && !stmt.balances.length)
    return problem("import_empty", "The file holds no transactions");
  return {
    statement: stmt,
    importer: BUDGET_IMPORTER_ID,
    detected,
    warnings: result.issues.filter((i) => !i.blocking),
    document: true,
  };
}

function fromBank(
  content: Uint8Array,
  bank: string | null,
  lang: StatementLang,
): Converted | StatementRefusal {
  const parsed = parseStatementFile(content, registry.institutions, bank);
  if (!parsed.ok) {
    if (parsed.reason === "unknown_bank") return problem("import_bank_unknown", "Unknown bank");
    if (parsed.reason === "not_detected")
      return problem(
        "import_bank_unknown",
        `Could not recognise the bank of this file. Choose one of: ${registry.institutions.csvIds().join(", ")}.`,
      );
    if (parsed.reason === "no_header") {
      const chosen = bank ?? detectBank(content, registry.institutions) ?? "";
      return problem(
        "import_header_missing",
        `No transaction header of ${registry.institutions.displayName(chosen, lang)} in this file`,
      );
    }
    if (parsed.reason === "undecodable")
      return problem("import_file_format", "The file cannot be read as text");
    return problem("import_file_format", "Unsupported or damaged file");
  }
  if (!parsed.statement.transactions.length)
    return problem("import_empty", "The file holds no transactions");
  return {
    statement: parsed.statement,
    importer: parsed.statement.bank,
    detected: bank === null,
    warnings: [],
    document: false,
  };
}

/** Python `convert`: read the file with the chosen importer (pure). */
function convert(
  content: Uint8Array,
  fileName: string,
  importer: string | null | undefined,
  lang: StatementLang,
): Converted | StatementRefusal {
  const choice = choiceOf(importer);
  if (choice === BUDGET_IMPORTER_ID) return fromDocument(content, fileName, false);
  if (choice === AUTO)
    return looksLikeBudgetDocument(content, fileName)
      ? fromDocument(content, fileName, true)
      : fromBank(content, null, lang);
  if (registry.institutions.csvIds().includes(choice)) return fromBank(content, choice, lang);
  const known = [AUTO, ...registry.institutions.csvIds(), BUDGET_IMPORTER_ID].join(", ");
  return problem("import_bank_unknown", `Unknown importer. Known: ${known}.`);
}

/** The account a statement goes to: an existing one, or what the commit opens. */
interface Target {
  readonly gid: string | null;
  readonly bank: string;
  readonly name: string;
  readonly currency: string;
  readonly iban: string | null;
  readonly externalId: string | null;
}

/** Python `_name_key`. */
const nameKey = (name: string): string =>
  normalizeText(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "konto";

/** A bank account a statement may go into (Python `resolve_account` with `account_id`). */
function bankAccount(read: Read, account: string) {
  const a = accountByGid(read, account);
  if (
    a === undefined ||
    a.removed ||
    a.bank === "manual" ||
    !(STATEMENT_ACCOUNT_TYPES as readonly string[]).includes(a.type)
  )
    return undefined;
  return a;
}

/** Python `resolve_account` (read-only), over the native account identity. */
function resolveTarget(
  read: Read,
  converted: Converted,
  opts: {
    readonly account?: string | undefined;
    readonly accountName?: string | null | undefined;
    readonly lang: StatementLang;
  },
): Target | StatementRefusal {
  const stmt = converted.statement;
  const checked = (t: Target): Target | StatementRefusal =>
    converted.document && t.gid !== null && stmt.currency.toUpperCase() !== t.currency.toUpperCase()
      ? problem(
          "import_currency_mismatch",
          `The file is in ${(stmt.currency || "?").toUpperCase().slice(0, 3)}, the account in ${(t.currency || "?").toUpperCase().slice(0, 3)}`,
        )
      : t;
  const existing = (a: NonNullable<ReturnType<typeof accountByGid>>): Target => ({
    gid: a.gid,
    bank: a.bank,
    name: a.name,
    currency: a.currency,
    iban: a.iban,
    externalId: null,
  });
  if (opts.account !== undefined) {
    const a = bankAccount(read, opts.account);
    if (a === undefined) return problem("not_found", "No bank account with this id in the profile");
    if (stmt.accountNumber && a.iban && ibanKey(a.iban) !== ibanKey(stmt.accountNumber))
      return problem("import_account_mismatch", "The file belongs to another account number");
    return checked(existing(a));
  }
  const iban = normalizeIban(stmt.accountNumber) || null;
  const name = (opts.accountName || stmt.accountName || "").trim();
  if (iban) {
    const a = accountByIbanKey(read, ibanKey(iban));
    if (a !== undefined) return checked(existing(a));
    const fallback = `${registry.institutions.displayName(stmt.bank, opts.lang)} ${iban.slice(-4)}`;
    return {
      gid: null,
      bank: stmt.bank,
      name: name || fallback,
      currency: stmt.currency,
      iban,
      externalId: null,
    };
  }
  const named = name || registry.institutions.displayName(stmt.bank, opts.lang);
  const externalId = `import:${nameKey(named)}`;
  const a = accountByExternalKey(read, stmt.bank, externalId);
  if (a !== undefined && !a.removed) return checked(existing(a));
  return {
    gid: null,
    bank: stmt.bank,
    name: named,
    currency: stmt.currency,
    iban: null,
    externalId,
  };
}

const balanceDays = (stmt: ParsedStatement): number =>
  new Set([...stmt.balances, ...stmt.closingBalances].map((b) => b.date)).size;

const shaNote = (sha: string) => `sha256:${sha}`;
const IMPORTER_NOTE = "importer:";

/** Python `remembered_importer`: the importer of the account's newest app import. */
function rememberedImporter(read: Read, account: string | null): string | null {
  if (account === null) return null;
  const notes = read<{ notes: string | null }>(
    `SELECT b.notes FROM import_batches b JOIN accounts a ON a.id = b.account_id
     WHERE a.gid = ? AND b.notes LIKE ? ORDER BY b.started_at DESC, b.id DESC LIMIT 1`,
    account,
    `% ${IMPORTER_NOTE}%`,
  )[0]?.notes;
  const token = (notes ?? "").split(" ").find((t) => t.startsWith(IMPORTER_NOTE));
  return token && token.length > IMPORTER_NOTE.length ? token.slice(IMPORTER_NOTE.length) : null;
}

/** Python `previous_imports`: this exact file (same sha256) or one with the same name, newest first. */
function previousImports(read: Read, sha: string, fileName: string) {
  const note = shaNote(sha);
  return read<{
    at: string;
    filename: string | null;
    inserted: number;
    notes: string | null;
  }>(
    `SELECT COALESCE(finished_at, started_at) AS at, filename, num_inserted AS inserted, notes
     FROM import_batches WHERE notes = ? OR notes LIKE ? OR filename = ?
     ORDER BY started_at DESC, id DESC LIMIT 5`,
    note,
    `${note} %`,
    fileName,
  ).map((b) => ({
    at: b.at.slice(0, 10),
    fileName: b.filename,
    inserted: b.inserted,
    sameFile: (b.notes ?? "").split(" ")[0] === note,
  }));
}

export interface StatementRequest {
  readonly fileName: string;
  readonly content: Uint8Array;
  readonly importer?: string | undefined;
  readonly accountType?: string | undefined;
  readonly accountName?: string | null | undefined;
  /** An existing bank account (else the file's account number, or a new account). */
  readonly account?: string | undefined;
  readonly lang: StatementLang;
}

export interface StatementWarning {
  readonly kind: string;
  readonly code: string;
  readonly row: number | null;
  readonly field: string | null;
  readonly message: string;
  readonly blocking: boolean;
}
const warningOf = (i: BudgetIssue): StatementWarning => ({
  kind: i.kind,
  code: issueCode(i),
  row: i.row,
  field: i.field,
  message: i.message,
  blocking: i.blocking,
});

export interface StatementPreviewRow {
  readonly row: number;
  readonly date: string;
  readonly amount: Decimal;
  readonly currency: string;
  readonly title: string | null;
  readonly counterparty: string | null;
  readonly status: "new" | "duplicate";
  readonly overlap: boolean;
}

export interface StatementPreview {
  readonly fileName: string;
  readonly sha256: string;
  readonly importer: { readonly id: string; readonly detected: boolean };
  readonly account: {
    readonly existing: boolean;
    readonly gid: string | null;
    readonly name: string;
    readonly currency: string;
    readonly ibanTail: string | null;
    readonly transactions: number;
    readonly institution: { readonly id: string; readonly name: string };
    readonly rememberedImporter: string | null;
  };
  readonly counts: {
    readonly rows: number;
    readonly new: number;
    readonly duplicates: number;
    readonly overlap: number;
    readonly skipped: number;
  };
  readonly range: { readonly from: string; readonly to: string } | null;
  readonly balances: number;
  readonly rows: readonly StatementPreviewRow[];
  readonly previousImports: readonly {
    readonly at: string;
    readonly fileName: string | null;
    readonly inserted: number;
    readonly sameFile: boolean;
  }[];
  readonly warnings: readonly StatementWarning[];
}

/** Python `_account_type`. */
const accountTypeOk = (kind: string | undefined): boolean => {
  const k = (kind ?? "checking").trim();
  return (
    (STATEMENT_ACCOUNT_TYPES as readonly string[]).includes(k) &&
    registry.accountTypes.ids().includes(k)
  );
};

const ibanTail = (iban: string | null): string | null => (iban ?? "").slice(-4) || null;

/** Python `preview`: what a commit of the file would do (read-only). */
export function previewStatement(
  read: Read,
  request: StatementRequest,
): { readonly ok: true; readonly preview: StatementPreview } | StatementRefusal {
  if (!accountTypeOk(request.accountType))
    return problem("import_account_type", "account_type must be one of: checking, savings, credit");
  const conv = convert(request.content, request.fileName, request.importer, request.lang);
  if ("ok" in conv) return conv;
  const target = resolveTarget(read, conv, request);
  if ("ok" in target) return target;
  const stmt = conv.statement;
  const warnings = conv.warnings.map(warningOf);
  let statuses: readonly RowStatus[];
  let existingRows = 0;
  if (target.gid !== null) {
    const stored = storedTxnsOfAccount(read, target.gid);
    const plan = planImport(stored, stmt.transactions, { newestDayRule: conv.document });
    statuses = plan.statuses;
    existingRows = stored.length;
    if (plan.numOverlap)
      warnings.push({
        kind: "overlap",
        code: "import.overlap",
        row: null,
        field: null,
        message: `${plan.numOverlap} rows are already covered by the account's stored history (another source: bank CSV, Open Banking); they are skipped`,
        blocking: false,
      });
  } else statuses = stmt.transactions.map(() => "new" as const);
  const fresh = statuses.filter((s) => s === "new").length;
  const dates = stmt.transactions.map((t) => t.bookingDate).sort();
  const sha = sha256Hex(request.content);
  return {
    ok: true,
    preview: {
      fileName: request.fileName,
      sha256: sha,
      importer: { id: conv.importer, detected: conv.detected },
      account: {
        existing: target.gid !== null,
        gid: target.gid,
        name: target.name,
        currency: target.currency,
        ibanTail: ibanTail(target.iban),
        transactions: existingRows,
        institution: {
          id: target.bank,
          name: registry.institutions.displayName(target.bank, request.lang),
        },
        rememberedImporter: rememberedImporter(read, target.gid),
      },
      counts: {
        rows: stmt.transactions.length + stmt.skippedRows,
        new: fresh,
        duplicates: statuses.length - fresh,
        overlap: statuses.filter((s) => s === "overlap").length,
        skipped: stmt.skippedRows,
      },
      range: dates.length
        ? { from: dates[0] as string, to: dates[dates.length - 1] as string }
        : null,
      balances: balanceDays(stmt),
      rows: stmt.transactions.slice(0, SAMPLE_ROWS).map((t, i) => ({
        row: i + 1,
        date: t.bookingDate,
        amount: t.amount,
        currency: t.currency.toUpperCase(),
        title: t.reference || t.description,
        counterparty: t.counterpartyName,
        status: statuses[i] === "new" ? "new" : "duplicate",
        overlap: statuses[i] === "overlap",
      })),
      previousImports: previousImports(read, sha, request.fileName),
      warnings,
    },
  };
}

export interface StatementCommitResult {
  readonly batch: string;
  readonly account: {
    readonly gid: string;
    readonly name: string;
    readonly currency: string;
    readonly ibanTail: string | null;
    readonly created: boolean;
  };
  readonly inserted: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly balances: number;
}

const commitInput = z.strictObject({
  fileName: z.string().min(1).max(200),
  content: z.instanceof(Uint8Array).refine((b) => b.length > 0 && b.length <= STATEMENT_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  importer: z.string().max(80).optional(),
  accountType: z.string().max(40).optional(),
  accountName: z.string().max(80).nullable().optional(),
  account: gid.optional(),
  lang: z.enum(["pl", "en"]),
});

/** A refusal reason the drawer reads as `error.<code>` (the command channel carries the code only). */
function refused(r: StatementRefusal) {
  return refuse(r.code);
}

/**
 * Python `commit`: re-read the file, resolve the account again and write it as one batch through
 * `importStatement` (the batch notes remember the file hash and the importer). The staged bytes
 * must still hash to the previewed file.
 */
export const commitStatementImport = defineCommand({
  id: "budget.commitStatementImport",
  input: commitInput,
  run(ctx: CommandContext, input) {
    if (sha256Hex(input.content) !== input.sha256) return refuse("staged_file_changed");
    if (!accountTypeOk(input.accountType)) return refuse("import_account_type");
    const conv = convert(input.content, input.fileName, input.importer, input.lang);
    if ("ok" in conv) return refused(conv);
    const target = resolveTarget(ctx.read, conv, input);
    if ("ok" in target) return refused(target);
    const result = importStatement.run(
      ctx,
      importStatement.input.parse({
        ...(target.gid === null ? {} : { account: target.gid }),
        statement: {
          bank: conv.statement.bank,
          accountNumber: conv.statement.accountNumber,
          accountName: conv.statement.accountName,
          currency: conv.statement.currency,
          transactions: conv.statement.transactions,
          balances: conv.statement.balances,
          closingBalances: conv.statement.closingBalances,
        },
        accountType: (input.accountType ?? "checking").trim(),
        accountName: target.name,
        externalId: target.externalId,
        source: "csv",
        filename: input.fileName,
        notes: `${shaNote(input.sha256)} ${IMPORTER_NOTE}${conv.importer}`,
        newestDayRule: conv.document,
      }),
    );
    if (!result.ok) return result;
    const account = target.gid === null ? null : accountByGid(ctx.read, target.gid);
    return ok<StatementCommitResult>({
      batch: result.value.batch,
      account: {
        gid: result.value.account,
        name: account?.name ?? target.name,
        currency: account?.currency ?? target.currency,
        ibanTail: ibanTail(account?.iban ?? target.iban),
        created: target.gid === null,
      },
      inserted: result.value.numInserted,
      duplicates: result.value.numDuplicates,
      skipped: conv.statement.skippedRows,
      balances: balanceDays(conv.statement),
    });
  },
});

/** Facts the drawer's done line reads after the commit: rows of the batch out of the default category. */
export function batchCategorized(read: Read, batch: string): number {
  return (
    read<{ n: number }>(
      `SELECT count(*) AS n FROM transactions t JOIN import_batches b ON b.id = t.import_batch_id
       WHERE b.gid = ? AND t.category_source IS NOT NULL AND t.category_source != 'default'`,
      batch,
    )[0]?.n ?? 0
  );
}

/** Internal transfer pairs of the vault (both legs carry the outflow row's group id). */
export function transferPairCount(read: Read): number {
  return (
    read<{ n: number }>(
      `SELECT count(DISTINCT transfer_group_id) AS n FROM transactions
       WHERE transfer_group_id IS NOT NULL AND is_internal_transfer = 1`,
    )[0]?.n ?? 0
  );
}

// ------------------------------------------------------------------------------- UI actions

/** Base64 text of at most `STATEMENT_MAX_BYTES` bytes (one more byte gets past the cap and is refused there). */
const STATEMENT_MAX_BASE64 = Math.ceil((STATEMENT_MAX_BYTES + 1) / 3) * 4;

/**
 * The picked file crosses the store channel as base64 text: UI action input is plain JSON (host-protocol
 * `toJson` refuses a Uint8Array), so the renderer encodes (`statementContentBase64`) and the host decodes (`statementContentBytes`).
 */
const statementContent = z
  .string()
  .max(STATEMENT_MAX_BASE64)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

/** The bytes of a `statementPreviewInputSchema` content (already checked as base64 by the schema). */
export function statementContentBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** A file's bytes as the base64 text `statementPreviewInputSchema` takes. */
export function statementContentBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const statementPreviewInputSchema = z.strictObject({
  fileName: z.string().min(1).max(200),
  content: statementContent,
  importer: z.string().max(80).optional(),
  accountType: z.string().max(40).optional(),
  accountName: z.string().max(80).nullable().optional(),
  account: gid.optional(),
  lang: z.enum(["pl", "en"]),
});
export type StatementPreviewInput = z.input<typeof statementPreviewInputSchema>;

/** The amounts cross the store channel as Decimals; the drawer formats them. */
export type StatementPreviewResult =
  | { readonly status: "previewed"; readonly stage: string; readonly preview: StatementPreview }
  | { readonly status: "refused"; readonly code: string; readonly detail: string | null };

export interface StatementCommitDone extends StatementCommitResult {
  readonly categorized: number;
  readonly transferPairs: number;
}
export type StatementCommitOutcome =
  | { readonly status: "committed"; readonly result: StatementCommitDone }
  | { readonly status: "refused"; readonly code: string; readonly detail: string | null };

export const budgetStatementPreview: UiAction<StatementPreviewInput, StatementPreviewResult> = {
  id: "budget.statementImport.preview",
};
export const budgetStatementCommit: UiAction<{ readonly stage: string }, StatementCommitOutcome> = {
  id: "budget.statementImport.commit",
};
