// The Import drawer of the Home head (ab24ab6 modules/investments/Drawers.tsx ImportDrawer): pick the account,
// the importer (and a generic CSV mapping), preview, reconcile, commit. The file is picked by the host when the
// preview runs (no browser file input: data-map GAP-5); approved file connectors are not listed (GAP-4). The hook
// owns the drawer's state and hands the View formatted rows.
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/Drawers.strings";
import { describeImportWarning } from "@cashu/ui-logic/core/messages";
import { accountLabel, dm, money, nTxns, qty, txnType } from "@cashu/ui-logic/investments/labels";
import { commitLabel } from "@cashu/ui-logic/investments/logic";
import type {
  AccountRow,
  CommitResult,
  ImportPreview,
  ImportWarning,
} from "@cashu/ui-logic/investments/types";
import { useState } from "react";
import type { InvestmentsHomeCommands } from "./useInvestmentsHomeData.js";

/** Built-in importers: [id, label] (labels in the current language). */
const importers = (): [string, string][] => [
  ["auto", S.impAuto],
  ["cashu", S.impCashu],
  ["generic_csv", S.impGeneric],
];
const importerName = (id: string | null | undefined) =>
  importers().find(([k]) => k === id)?.[1] ?? id ?? "-";

type ImportTone = "positive" | "negative" | null;
export interface ImportWarningText {
  text: string;
  detail: string | null;
}
const warningText = (w: ImportWarning): ImportWarningText => {
  const d = describeImportWarning(w);
  return { text: `${w.row != null ? S.row(w.row) : ""}${d.text}`, detail: d.detail };
};

export interface ImportDrawerInput {
  accounts: readonly AccountRow[];
  initialAccount: number | null;
  commands: Pick<InvestmentsHomeCommands, "previewImport" | "commitImport" | "importBusy">;
  onClose(): void;
  onDone(r: CommitResult): void;
  onAddAccount(): void;
  onManual(): void;
  onClassify(): void;
}

/** Mounted while the drawer is open, so every opening starts at its first step. */
export function useImportDrawer(input: ImportDrawerInput) {
  const { accounts } = input;
  const single = accounts.length === 1 ? (accounts[0]?.id ?? null) : null;
  const [step, setStep] = useState(input.initialAccount != null || single != null ? 1 : 0);
  const [acc, setAcc] = useState<number | null>(input.initialAccount ?? single);
  const account = accounts.find((a) => a.id === acc) ?? null;
  const [importer, setImporter] = useState("auto");
  const [mapping, setMapping] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [problems, setProblems] = useState(false);
  const [all, setAll] = useState(false);
  const [fixes, setFixes] = useState<ReadonlySet<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<CommitResult | null>(null);
  const busy = input.commands.importBusy;

  const runPreview = async () => {
    if (acc == null) return;
    setErr(null);
    const r = await input.commands.previewImport({
      account_id: acc,
      importer,
      mapping: importer === "generic_csv" ? mapping : null,
    });
    if ("cancelled" in r) return;
    if ("error" in r) {
      setErr(r.error);
      return;
    }
    const p = r.preview;
    setPreview(p);
    setFixes(
      new Set(
        (p.reconciliation?.diffs ?? [])
          .filter((d) => d.correction)
          .map((d) => String(d.instrument_id)),
      ),
    );
    setStep(2);
  };
  const commit = async () => {
    if (!preview || acc == null) return;
    setErr(null);
    const r = await input.commands.commitImport([...fixes]);
    if ("error" in r) {
      setErr(r.error);
      return;
    }
    setDone(r.result);
    setStep(3);
    input.onDone(r.result);
  };

  const counts = preview?.counts;
  const skipped = preview ? preview.warnings.filter((w) => w.row != null) : [];
  const rows = preview
    ? preview.rows.filter((r) => !problems || r.status !== "new" || r.instrument?.new)
    : [];
  const shown = all ? rows : rows.slice(0, 8);
  const recon = preview?.reconciliation ?? null;
  const signed = (v: number) => `${v > 0 ? "+" : ""}${qty(v)}`;

  return {
    title: S.importTitle,
    accountTag: account ? accountLabel(account, [...accounts]) : null,
    step,
    steps: [S.stepAccount, S.stepFile, S.stepPreview, S.stepDone],
    error: err,
    busy,
    onClose: input.onClose,
    // step 0
    accountOptions: accounts.map((a) => ({
      value: String(a.id),
      title: accountLabel(a, [...accounts]),
      desc: S.accountDesc(a.name, a.currency, a.importer ? importerName(a.importer) : null, null),
    })),
    account: acc == null ? null : String(acc),
    onAccount: (v: string) => setAcc(Number(v)),
    onAddAccount: input.onAddAccount,
    // step 1
    importer,
    importerOptions: importers().map(([value, label]) => ({ value, label })),
    onImporter: setImporter,
    remembered: account?.importer
      ? `${S.remembered(importerName(account.importer))}${account.has_mapping ? S.withMapping : ""}`
      : null,
    mapping: importer === "generic_csv" ? mapping : null,
    mappingLabel: `${S.mappingLabel}${account?.has_mapping ? S.emptyRemembered : ""}`,
    onMapping: setMapping,
    // step 2
    preview: preview && {
      meta: {
        file: preview.file_name,
        importer: `${S.importerIs} ${importerName(preview.importer.id ?? preview.importer.name)}${preview.importer.requested === "auto" ? S.autoDetected : ""} · ${S.nRows(counts?.rows ?? preview.rows.length)} · `,
      },
      errors: preview.errors.slice(0, 6).map(warningText),
      before: preview.previous_imports[0]
        ? S.importedBefore(dm(preview.previous_imports[0].at))
        : null,
      counts: {
        fresh: S.nNew(counts?.new ?? 0),
        duplicates: S.nDuplicates(counts?.duplicates ?? 0),
        skipped: skipped.length > 0 ? S.nSkipped(skipped.length) : null,
      },
      problems,
      onProblems: setProblems,
      rows: shown.map((r) => ({
        key: r.row,
        date: r.date,
        type: txnType(r.type),
        instrument: r.instrument?.label ?? null,
        newInstrument: !!r.instrument?.new,
        quantity: r.quantity != null ? qty(r.quantity) : "-",
        amount: money(r.amount, r.cash_currency, true),
        tone: (r.status === "duplicate"
          ? null
          : r.amount > 0
            ? "positive"
            : r.amount < 0
              ? "negative"
              : null) as ImportTone,
        duplicate: r.status === "duplicate",
      })),
      skipped: skipped.map(warningText),
      more: !all && rows.length > shown.length ? S.moreRows(rows.length - shown.length) : null,
      onAll: () => setAll(true),
      empty: !rows.length && !skipped.length ? (problems ? S.noProblems : S.noTxnsInFile) : null,
      recon:
        recon && recon.diffs.length > 0
          ? {
              snapshot: recon.as_of
                ? S.snapshotFrom(
                    preview.account.broker_name.replace(/ Broker$/, ""),
                    dm(recon.as_of),
                  )
                : null,
              state: recon.mismatches ? S.nDiffs(recon.mismatches) : S.matching,
              rows: recon.diffs.map((d) => {
                const id = String(d.instrument_id);
                return {
                  key: id,
                  label: d.label,
                  broker: qty(d.broker_quantity),
                  computed: qty(d.computed_quantity),
                  delta: d.delta ? signed(d.delta) : null,
                  correction: d.correction
                    ? {
                        on: fixes.has(id),
                        text: S.correction(
                          d.delta > 0,
                          signed(d.delta),
                          d.correction.date ? dm(d.correction.date) : null,
                        ),
                        onChange: (on: boolean) =>
                          setFixes((cur) => {
                            const next = new Set(cur);
                            if (on) next.add(id);
                            else next.delete(id);
                            return next;
                          }),
                      }
                    : null,
                };
              }),
            }
          : null,
      newOnes: preview.new_instruments.length
        ? S.toClassifyAfter(preview.new_instruments.map((x) => x.symbol ?? x.label).join(", "))
        : null,
    },
    onChangeImporter: () => setStep(1),
    onManual: input.onManual,
    // step 3
    done: done && {
      title: S.imported(nTxns(done.inserted), done.corrections),
      duplicates: done.duplicates ? S.dupSkipped(done.duplicates) : "",
      classify: done.new_instrument_ids.length ? S.classify(done.new_instrument_ids.length) : null,
    },
    onClassify: input.onClassify,
    // footer
    footer:
      step === 2 && preview
        ? {
            kind: "preview" as const,
            commit: busy ? S.importing : commitLabel(counts?.new ?? 0, fixes.size),
            commitDisabled: busy || !preview.can_commit || (!counts?.new && !fixes.size),
          }
        : step === 1
          ? {
              kind: "file" as const,
              back: accounts.length > 1,
              run: busy ? S.checking : S.preview,
              runDisabled:
                acc == null ||
                busy ||
                (importer === "generic_csv" && !mapping.trim() && !account?.has_mapping),
            }
          : step === 0
            ? { kind: "account" as const, nextDisabled: acc == null, next: C.next }
            : { kind: "done" as const, close: C.close },
    onBack: () => setStep(step === 2 ? 1 : 0),
    onNext: () => setStep(1),
    onPreview: () => {
      void runPreview();
    },
    onCommit: () => {
      void commit();
    },
  };
}
export type ImportDrawerState = ReturnType<typeof useImportDrawer>;
