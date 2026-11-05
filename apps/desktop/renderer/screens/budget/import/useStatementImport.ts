// The statement import drawer (ab24ab6 modules/budget/ImportDrawer.tsx): Źródło (bank file, Open Banking, the
// connector slot) -> Plik (file, bank, account, account type, name) -> Podgląd -> Gotowe. The native app has no
// statement preview / commit action for the desktop yet: `Podgląd` answers with that notice (the drawer stays
// on Plik); Open Banking shows the `eb login` command or the not-configured notice as before.
import { S } from "@cashu/i18n/budget/ImportDrawer.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { budgetDesktopQueries } from "@cashu/store/budget/queries";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { bankOptions, cliPrefix, statementTypes } from "@cashu/ui-logic/budget/logic";
import { useState } from "react";
import { T } from "../BudgetShell.strings.js";
import { builtinSources, connectorSources, isFileSource } from "./importSources.js";

const queries = budgetDesktopQueries();

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
}

/** Mounted while the drawer is open, so every opening starts at its first step. */
export function useStatementImport(input: StatementImportInput) {
  const { privacy } = useUiEnv();
  const settings = useQuery(queries.settings);
  const [step, setStep] = useState<number>(input.initialStep);
  const [source, setSource] = useState("csv");
  const [file, setFile] = useState<string | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [bank, setBank] = useState("auto");
  const [accountType, setAccountType] = useState("checking");
  const [accountName, setAccountName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const sources = [...builtinSources(input.ebConfigured), ...connectorSources()];
  const resetFile = () => {
    setFile(null);
    setFileKey((k) => k + 1);
  };
  const accounts = settings.accounts.map((a) => ({
    value: a.gid,
    label: [privacy ? "•••" : a.name, a.currency].filter(Boolean).join(" · "),
  }));
  const back = () => {
    setErr(null);
    resetFile();
    setStep(0);
  };

  return {
    title: S.title,
    steps: S.steps,
    step,
    error: err,
    onClose: input.onClose,
    // step 0
    sources,
    source,
    onSource: (v: string) => {
      if (v !== source) resetFile();
      setSource(v);
    },
    openBanking: source === "open_banking",
    ebConfigured: input.ebConfigured,
    ebCommand: `${cliPrefix(null, input.slug)} eb login "mBank"`,
    onCopy: () => input.onCopy(`${cliPrefix(null, input.slug)} eb login "mBank"`),
    // step 1
    fileKey,
    onFile: (name: string | null) => {
      setFile(name);
      setErr(null);
    },
    showBank: !source.startsWith("connector:"),
    bank,
    bankOptions: bankOptions(null).map(([value, label]) => ({ value, label })),
    onBank: setBank,
    accounts,
    accountId,
    accountOptions: [{ value: "", label: S.accountAuto }, ...accounts],
    onAccount: setAccountId,
    accountType,
    typeOptions: statementTypes().map(([value, label]) => ({ value, label })),
    onAccountType: setAccountType,
    accountName,
    onAccountName: setAccountName,
    // footer
    footer:
      step === 0
        ? source === "open_banking"
          ? { kind: "openBanking" as const, instructions: S.instructions, close: C.close }
          : { kind: "source" as const, next: C.next, nextDisabled: !isFileSource(source) }
        : { kind: "file" as const, back: S.back, run: S.preview, runDisabled: file === null },
    onNext: () => setStep(1),
    onBack: back,
    onInstructions: () => {
      input.onClose();
      input.onInstructions();
    },
    onPreview: () => setErr(T.importUnavailable),
  };
}
export type StatementImportState = ReturnType<typeof useStatementImport>;
