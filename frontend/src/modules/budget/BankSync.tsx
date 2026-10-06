// The budget's tabbar actions while a budget tab is open: `Import` (the statement import drawer at its file step,
// first-steps section 6) and the bank sync (Enable Banking). A sync belongs to the profile it was started for: the
// set lives at module scope so a remount (refresh, tab switch) keeps it.
import { useEffect, useRef, useState } from "react";
import { postResync } from "../../core/api";
import { moduleSyncLines } from "../../core/connectors";
import { type Binding, getBindings } from "../../core/connectorsApi";
import { ProposalDrawer } from "../../core/ProposalDrawer";
import { getProposals } from "../../core/proposalsApi";
import { useAsync, usePoll } from "../../hooks";
import { ck } from "../../swr";
import { useShell } from "../../core/context";
import { errorText } from "../../core/messages";
import type { TabActionProps } from "../../core/types";
import { plural } from "../../format";
import { useToast } from "../../ui";
import { StatementImportDrawer } from "./ImportDrawer";
import { bankAccounts, resyncBankText } from "./logic";

const running = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function BankSync({ slug, profileName, networth, refresh, bindings = [], onSynced, onProposal }: TabActionProps & {
  /** The profile's budget fetch bindings: the button also syncs them (and names them in the toasts). */
  bindings?: readonly Binding[];
  /** After every sync (the pending proposals re-read at once). */
  onSynced?: () => void;
  /** `Zobacz` on a connector line that stored a proposal. */
  onProposal?: (proposalId: number) => void;
}) {
  const toast = useToast();
  const [, rerender] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    return () => { alive.current = false; listeners.delete(l); };
  }, []);

  const banks = bankAccounts(networth?.accounts ?? []);
  const connectors = bindings.length > 0;
  const busy = running.has(slug);

  const sync = async () => {
    running.add(slug); notify();
    let ok = false;
    try {
      const res = await postResync(slug);
      ok = res.ok;
      const msg = resyncBankText(res);
      if (msg) toast(`${profileName}: ${msg}`, 5000);
      const name = (l: { binding_id?: number; connector_id?: string }) => bindings.find((b) => b.id === l.binding_id)?.connector_name ?? l.connector_id ?? "Konektor";
      for (const line of moduleSyncLines(res.connectors, name)) {
        const pid = line.proposalId;
        // the tabbar left (other profile or module): the line names the profile, the proposal waits in its tabbar
        if (!alive.current) toast(`${profileName}: ${line.text}`, 6000);
        else if (pid != null && onProposal) toast(line.text, 6000, { label: "Zobacz", onClick: () => onProposal(pid) });
        else toast(line.text, line.failed ? 7000 : 5000);
      }
      onSynced?.();
    } catch (e) {
      toast(`${profileName}: ${errorText(e)}`, 5000);
    } finally {
      running.delete(slug); notify();
    }
    if (ok && alive.current) refresh();
  };

  return (
    <button className="btn" onClick={sync} disabled={busy || (!banks.length && !connectors)}
      title={connectors ? "Pobierz nowe transakcje z banków (Enable Banking) i konektorów"
        : banks.length ? "Pobierz nowe transakcje z banków (Enable Banking)" : "Brak kont bankowych do synchronizacji"}>
      {busy ? "Synchronizuję…" : "↻ Synchronizuj"}
    </button>
  );
}

/** `Import` (a CSV statement, next month's file is one click from any budget tab) + `↻ Synchronizuj`. */
export function BudgetActions(props: TabActionProps) {
  const toast = useToast();
  const { reloadProfiles } = useShell();
  const [open, setOpen] = useState(false);
  const stale = useRef(false);
  // Connector sync results waiting for approval (design/v3/connectors section 6): one tabbar button.
  const pending = usePoll(() => getProposals(props.slug).then((l) => l.filter((x) => x.kind === "budget_import")), 30000, [props.slug],
    { key: ck(props.slug, "budget", "proposals", "pending") });
  const waiting = pending.data ?? [];
  const [proposal, setProposal] = useState<number | null>(null);
  const bindings = useAsync(() => getBindings(props.slug).catch(() => []), [props.slug]);
  const budgetBindings = (bindings.data ?? []).filter((b) => b.module === "budget");
  const proposalDone = (approved: boolean) => {
    toast(approved ? "Zaimportowano" : "Odrzucono", 3000);
    if (approved) props.refresh();
    const next = waiting.find((x) => x.id !== proposal);
    setProposal(next ? next.id : null);
    pending.reload();
  };
  return (
    <>
      {waiting.length > 0 && (
        <button className="btn" onClick={() => setProposal(waiting[0].id)} title="Import z konektora czeka na zatwierdzenie">Do zatwierdzenia · {waiting.length}</button>
      )}
      <button className="btn" title="Wyciąg CSV z banku" onClick={() => setOpen(true)}>Import</button>
      <BankSync {...props} bindings={budgetBindings} onSynced={pending.reload} onProposal={setProposal} />
      {proposal != null && (
        <ProposalDrawer key={proposal} slug={props.slug} id={proposal} version={null} onClose={() => setProposal(null)} onChanged={pending.reload}
          onDone={proposalDone} />
      )}
      {open && (
        <StatementImportDrawer slug={props.slug} initialStep={1} fromTab
          onClose={() => { setOpen(false); if (stale.current) { stale.current = false; props.refresh(); void reloadProfiles(); } }}
          onDone={(r) => { stale.current = true; toast(`Zaimportowano ${plural(r.inserted, "transakcję", "transakcje", "transakcji")}`, 3500); }} />
      )}
    </>
  );
}
