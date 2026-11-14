// The budget's tab bar actions while a budget tab is open (ab24ab6 modules/budget/BankSync.tsx BudgetActions):
// `Do zatwierdzenia · n` (connector imports waiting for approval), `Import` (the statement drawer at its file
// step) and `↻ Synchronizuj` (the host's bank sync). A sync belongs to the profile it was started for: the set
// lives at module scope so a remount keeps it.
import { S } from "@cashu/i18n/budget/BankSync.strings";
import { proposalList } from "@cashu/store/core/desktop-proposals";
import { useQuery } from "@cashu/store-react";
import { Button, useToast } from "@cashu/ui";
import { resyncBankText } from "@cashu/ui-logic/budget/logic";
import { errorText } from "@cashu/ui-logic/core/messages";
import { useEffect, useRef, useState } from "react";
import { T } from "../BudgetShell.strings.js";
import { StatementImportView } from "../import/StatementImportView.js";
import { useStatementImport } from "../import/useStatementImport.js";
import { useBankingStatus } from "./useBankingStatus.js";

const running = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

export interface BudgetActionsProps {
  vault: string;
  slug: string;
  profileName: string;
  /** Opens a proposal in the shell's proposal drawer (false when it cannot). */
  onProposal(gid: string): boolean;
  onInstructions(): void;
}

function StatementImport(props: {
  slug: string;
  ebConfigured: boolean;
  onClose(): void;
  onInstructions(): void;
}) {
  const toast = useToast();
  const state = useStatementImport({
    slug: props.slug,
    initialStep: 1,
    fromTab: true,
    ebConfigured: props.ebConfigured,
    onClose: props.onClose,
    onInstructions: props.onInstructions,
    onCopy: (text) => void navigator.clipboard.writeText(text),
    onDone: (inserted) => toast(S.importedN(inserted), 3500),
  });
  return <StatementImportView state={state} />;
}

export function BudgetActions(props: BudgetActionsProps) {
  const toast = useToast();
  const [, rerender] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    return () => {
      alive.current = false;
      listeners.delete(l);
    };
  }, []);
  const banking = useBankingStatus();
  const waiting = useQuery(proposalList, { status: "pending", privacy: false }).filter(
    (p) => p.kind === "budget_import",
  );
  const [open, setOpen] = useState(false);
  const busy = running.has(props.vault);
  const sync = async () => {
    running.add(props.vault);
    notify();
    try {
      const r = await banking.sync();
      toast(
        `${props.profileName}: ${r.ok ? T.synced : resyncBankText({ ok: false, error: r.error ? errorText(r.error) : "" })}`,
        5000,
      );
    } finally {
      running.delete(props.vault);
      notify();
    }
  };
  return (
    <>
      {waiting.length > 0 && (
        <Button
          title={S.pendingTitle}
          onPress={() => {
            const first = waiting[0];
            if (first) props.onProposal(first.gid);
          }}
        >
          {S.pending(waiting.length)}
        </Button>
      )}
      <Button title={S.importTitle} onPress={() => setOpen(true)}>
        {S.import}
      </Button>
      <Button
        disabled={busy || banking.sessions === 0}
        pending={busy}
        title={banking.sessions ? S.syncTitleBanks : S.syncTitleNone}
        onPress={sync}
      >
        {S.sync}
      </Button>
      {open && (
        <StatementImport
          slug={props.slug}
          ebConfigured={banking.configured}
          onClose={() => setOpen(false)}
          onInstructions={props.onInstructions}
        />
      )}
    </>
  );
}
