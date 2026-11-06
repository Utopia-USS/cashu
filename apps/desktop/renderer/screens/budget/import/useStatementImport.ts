// The statement import drawer (ab24ab6 modules/budget/ImportDrawer.tsx): Źródło (bank file, Open Banking, the
// connector slot) -> Plik (file, bank, account, account type, name) -> Podgląd (new / duplicates, the account it
// lands in) -> Gotowe. Nothing is written before `Importuj`. The picked file's bytes go to the host's preview
// action (`budget.statementImport.preview`), which stages them for the commit; the file stays on this computer.
// Opened from the budget first steps (step 0) or from the tabbar `Import` (step 1, the bank file).
import { core } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { S } from "@cashu/i18n/budget/ImportDrawer.strings";
import { C } from "@cashu/i18n/core/common.strings";
import {
  budgetDesktopQueries,
  budgetStatementCommit,
  budgetStatementPreview,
  STATEMENT_MAX_BYTES,
  type StatementCommitDone,
  type StatementPreview,
} from "@cashu/store/budget/queries";
import { useQuery, useUiAction } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import {
  bankName,
  bankOptions,
  cliPrefix,
  dmShort,
  importDoneLine,
  previewRows,
  statementErrorKey,
  statementTypes,
} from "@cashu/ui-logic/budget/logic";
import { cur } from "@cashu/ui-logic/core/format";
import { describeImportWarning, label } from "@cashu/ui-logic/core/messages";
import { useState } from "react";
import { builtinSources, connectorSources, isFileSource } from "./importSources.js";

const queries = budgetDesktopQueries();
const registry = core.builtinRegistry();
const MASK = "•••";

/** The `Bank` select's choices (Python GET /budget/import/importers without connectors): the banks with a CSV
 * parser and the cashU format (`bankOptions` puts `rozpoznaj automatycznie` first). */
const importerChoices = () => [
  ...registry.institutions.csvIds().map((id) => ({
    id,
    name: registry.institutions.displayName(id, lang()),
    kind: "bank",
    available: true,
  })),
  { id: "cashu-budget", name: S.formatName, kind: "format", available: true },
];

const signed = (v: number, c: string) => (v > 0.004 ? `+${cur(v, c)}` : cur(v, c));
type Tone = "positive" | "negative" | null;

export interface StatementImportInput {
  slug: string;
  /** 0 = Źródło (first steps), 1 = Plik with the bank file (tabbar `Import`). */
  initialStep: 0 | 1;
  /** Opened from the tabbar: `Gotowe` offers no `Wydatki →`. */
  fromTab?: boolean;
  /** The Enable Banking key is set up (the host's banking status). */
  ebConfigured: boolean;
  onClose(): void;
  /** `Instrukcja`: the module's CLI / Claude Code page. */
  onInstructions(): void;
  onCopy(text: string): void;
  /** At commit (the drawer stays open on `Gotowe`): the inserted rows. */
  onDone?(inserted: number): void;
  /** `Wydatki →` on `Gotowe`. */
  onExpenses?(): void;
}

/** Mounted while the drawer is open, so every opening starts at its first step. */
export function useStatementImport(input: StatementImportInput) {
  const { privacy } = useUiEnv();
  const bankAccounts = useQuery(queries.statementAccounts, { lang: lang() });
  const previewAction = useUiAction(budgetStatementPreview);
  const commitAction = useUiAction(budgetStatementCommit);
  const [step, setStep] = useState<number>(input.initialStep);
  const [source, setSource] = useState("csv");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [bank, setBank] = useState("auto");
  const [accountType, setAccountType] = useState("checking");
  const [accountName, setAccountName] = useState("");
  const [accountId, setAccountId] = useState(""); // "" = by the file (its account number) or a new account
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [onlyNew, setOnlyNew] = useState(false);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // the English detail under `err` (a cashU format file: which rows / fields failed)
  const [errDetail, setErrDetail] = useState<string | null>(null);
  const [done, setDone] = useState<StatementCommitDone | null>(null);

  const choices = importerChoices();
  const sources = [...builtinSources(input.ebConfigured), ...connectorSources()];
  const clearErr = () => {
    setErr(null);
    setErrDetail(null);
  };
  /** A refusal: its label (`error.<code>`), else the English detail, else the code. */
  const fail = (code: string, detail: string | null) => {
    const { key } = statementErrorKey({ code });
    const text = (key && label(key)) || label(code);
    setErr(text || detail || code);
    if (key === "error.import_invalid" && text) setErrDetail(detail);
  };
  /** Back to the file step with nothing picked (a new source, an expired preview). */
  const resetFile = () => {
    setFile(null);
    setPreview(null);
    setStage(null);
    setAll(false);
    setOnlyNew(false);
    setFileKey((k) => k + 1);
  };
  const runPreview = async () => {
    if (!file) return;
    if (file.size > STATEMENT_MAX_BYTES) {
      setErr(label("error.file_too_large"));
      return;
    }
    setBusy(true);
    clearErr();
    try {
      const content = new Uint8Array(await file.arrayBuffer());
      const r = await previewAction.run({
        fileName: file.name,
        content,
        importer: bank,
        accountType,
        accountName: accountName.trim() || null,
        ...(accountId ? { account: accountId } : {}),
        lang: lang(),
      });
      if (r.status !== "completed") {
        setErr(label(`error.${r.reason}`) ?? r.reason);
        return;
      }
      if (r.value.status === "refused") {
        fail(r.value.code, r.value.detail);
        return;
      }
      setPreview(r.value.preview);
      setStage(r.value.stage);
      setAll(false);
      setStep(2);
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview || !stage) return;
    setBusy(true);
    clearErr();
    try {
      const r = await commitAction.run({ stage });
      if (r.status !== "completed") {
        setErr(label(`error.${r.reason}`) ?? r.reason);
        return;
      }
      if (r.value.status === "refused") {
        // the staged file is gone (expired, the host restarted): pick the file again
        if (r.value.code === "not_found") {
          resetFile();
          setStep(1);
          setErr(label("import.preview_expired"));
        } else fail(r.value.code, r.value.detail);
        return;
      }
      setDone(r.value.result);
      setStep(3);
      input.onDone?.(r.value.result.inserted);
    } finally {
      setBusy(false);
    }
  };

  const accountLabel = (a: (typeof bankAccounts)[number]) =>
    [
      a.bankName,
      privacy ? MASK : a.name,
      a.ibanTail && !privacy ? `…${a.ibanTail}` : "",
      a.currency,
    ]
      .filter(Boolean)
      .join(" · ");
  const counts = preview?.counts;
  // The account's bank; "Plik importowany już" only for the same bytes.
  const accBank = preview
    ? preview.account.institution.name || bankName(preview.account.institution.id, choices)
    : "";
  const again0 = preview?.previousImports.find((p) => p.sameFile !== false) ?? null;
  const { shown, rest } = preview
    ? previewRows(preview.rows, onlyNew, all)
    : { shown: [], rest: 0 };
  const importerLabel = preview ? bankName(preview.importer.id, choices) : "";
  const accountName0 = preview ? (privacy ? MASK : preview.account.name) : "";

  return {
    title: S.title,
    tag: preview ? accBank || importerLabel : null,
    steps: S.steps,
    step,
    error: err,
    errorDetail: errDetail,
    onClose: input.onClose,
    // step 0
    sources,
    source,
    onSource: (v: string) => {
      if (v !== source) resetFile(); // a file picked for one source is never sent with another
      setSource(v);
    },
    openBanking: source === "open_banking",
    ebConfigured: input.ebConfigured,
    ebCommand: `${cliPrefix(null, input.slug)} eb login "mBank"`,
    onCopy: () => input.onCopy(`${cliPrefix(null, input.slug)} eb login "mBank"`),
    // step 1
    fileKey,
    onFile: (picked: File | null) => {
      setFile(picked);
      setPreview(null);
      setStage(null);
      clearErr();
    },
    showBank: !source.startsWith("connector:"),
    bank,
    bankOptions: bankOptions(choices).map(([value, label]) => ({ value, label })),
    onBank: setBank,
    hasAccounts: bankAccounts.length > 0,
    accountId,
    accountOptions: [
      { value: "", label: S.accountAuto },
      ...bankAccounts.map((a) => ({ value: a.gid, label: accountLabel(a) })),
    ],
    onAccount: (v: string) => {
      setAccountId(v);
      setPreview(null);
      setStage(null);
    },
    accountType,
    typeOptions: statementTypes().map(([value, label]) => ({ value, label })),
    onAccountType: setAccountType,
    accountName,
    onAccountName: setAccountName,
    // step 2
    preview:
      preview && counts
        ? {
            fileName: preview.fileName,
            meta: ` · ${preview.importer.detected ? `${importerLabel}${S.detected}` : importerLabel} · ${S.nRows(counts.rows)}${preview.range ? ` · ${dmShort(preview.range.from)}-${dmShort(preview.range.to)}` : ""} · `,
            account: [
              accBank,
              accountName0,
              preview.account.ibanTail && !privacy ? `…${preview.account.ibanTail}` : null,
              preview.account.currency,
            ]
              .filter(Boolean)
              .join(" · "),
            accountTag: preview.account.existing
              ? { tone: null, text: S.exists(preview.account.transactions) }
              : { tone: "info" as const, text: S.newAccount },
            before: again0 ? S.importedBefore(dmShort(again0.at)) : null,
            warnings: preview.warnings.slice(0, 5).map((w) => {
              const d = describeImportWarning({ kind: w.kind, code: w.code, message: w.message });
              return `${w.row != null ? S.rowPrefix(w.row) : ""}${d.text}`;
            }),
            counts: {
              fresh: S.nNew(counts.new),
              duplicates: S.nDuplicates(counts.duplicates),
              duplicatesTitle: counts.overlap ? S.overlap(counts.overlap) : undefined,
              skipped: counts.skipped > 0 ? S.nSkipped(counts.skipped) : null,
            },
            onlyNew,
            onOnlyNew: setOnlyNew,
            allInDb: counts.new === 0,
            rows: shown.map((r) => {
              const dup = r.status === "duplicate";
              const v = Number(r.amount.format("f"));
              return {
                key: r.row,
                date: r.date,
                title: r.title ? (privacy ? MASK : r.title) : null,
                counterparty: r.counterparty ? (privacy ? MASK : r.counterparty) : null,
                amount: signed(v, r.currency),
                tone: (dup ? null : v > 0 ? "positive" : v < 0 ? "negative" : null) as Tone,
                duplicate: dup,
              };
            }),
            more: rest > 0 ? S.moreRows(rest) : null,
            onAll: () => setAll(true),
            empty: shown.length ? null : onlyNew ? S.noNewRows : S.noTransactions,
          }
        : null,
    onChange: () => setStep(1),
    // step 3
    done: done && {
      title: S.importedN(done.inserted),
      line: importDoneLine({
        batch_id: null,
        account: {
          id: 0,
          name: privacy ? MASK : done.account.name,
          currency: done.account.currency,
          iban_tail: privacy ? null : done.account.ibanTail,
          created: done.account.created,
        },
        inserted: done.inserted,
        duplicates: done.duplicates,
        skipped: done.skipped,
        balances: done.balances,
        categorized: done.categorized,
        transfer_pairs: done.transferPairs,
      }),
      expenses: !input.fromTab,
    },
    onAgain: () => {
      resetFile();
      setDone(null);
      clearErr();
      setStep(1);
    },
    onExpenses: () => {
      input.onClose();
      input.onExpenses?.();
    },
    // footer
    footer:
      step === 0
        ? source === "open_banking"
          ? { kind: "openBanking" as const, instructions: S.instructions, close: C.close }
          : { kind: "source" as const, next: C.next, nextDisabled: !isFileSource(source) }
        : step === 1
          ? {
              kind: "file" as const,
              back: S.back,
              run: busy ? S.checking : S.preview,
              runDisabled: file === null || busy,
            }
          : step === 2 && preview
            ? {
                kind: "preview" as const,
                back: S.back,
                commit: busy ? S.importing : S.importN(counts?.new ?? 0),
                commitDisabled: busy || !counts?.new,
              }
            : { kind: "done" as const, close: C.close },
    onNext: () => setStep(1),
    onBack: () => {
      // the file input remounts empty on step 0 -> 1: no file kept that the input does not show
      clearErr();
      resetFile();
      setStep(0);
    },
    onBackToFile: () => setStep(1),
    onInstructions: () => {
      input.onClose();
      input.onInstructions();
    },
    onPreview: () => {
      void runPreview();
    },
    onCommit: () => {
      void commit();
    },
  };
}
export type StatementImportState = ReturnType<typeof useStatementImport>;
