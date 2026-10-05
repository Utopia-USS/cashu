// Strategy and agent proposals in Ustawienia > Agent AI (ia-v2.md 8, F-05): the strategy pill and popover are
// gone from the investments page; validation, inactive rules, versions and pending proposals live here (and in
// the change log / the review's Strategia row).
import { useState } from "react";
import { useShell } from "../../../core/context";
import { errorText } from "../../../core/messages";
import { useAsync } from "../../../hooks";
import { Skeleton, useToast } from "../../../ui";
import { getProposals, getStrategy, postStrategyInit, postStrategyReload } from "../api";
import { ProposalDrawer } from "../Drawers";
import { StrategyPopover, strategyTag } from "../Header";

export function InvestmentsStrategySettings() {
  const { slug, refresh } = useShell();
  const toast = useToast();
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);
  const st = useAsync(() => getStrategy(slug).catch(() => null), [slug, nonce]);
  const props = useAsync(() => getProposals(slug).catch(() => []), [slug, nonce]);
  const [open, setOpen] = useState<number | null>(null);
  const s = st.data;
  const brief = s ? { state: s.state, errors: s.errors, warnings: s.warnings, inactive_rules: s.inactive_rules.length } : null;
  return (
    <div style={{ marginTop: 18 }}>
      <div className="controls" style={{ marginBottom: 6 }}>
        <strong style={{ fontSize: 14 }}>Strategia inwestycji</strong>{s && strategyTag(brief)}
      </div>
      {!s && st.loading ? <Skeleton h={60} /> : (
        <div className="card" style={{ padding: "12px 14px", fontSize: 13 }}>
          <StrategyPopover st={s} proposals={props.data ?? []} onProposal={setOpen}
            onInit={() => { void postStrategyInit(slug).then(() => postStrategyReload(slug).catch(() => null)).then(() => { toast("Utworzono strategię z szablonu", 3000); reload(); }).catch((e: unknown) => toast(`Nie utworzono strategii: ${errorText(e)}`, 4000)); }}
            onReload={() => { void postStrategyReload(slug).then((r) => { toast(r.version != null ? `Strategia wczytana · v${r.version}` : "Brak pliku strategii", 2500); reload(); }).catch((e: unknown) => toast(`Nie wczytano strategii: ${errorText(e)}`, 4000)); }} />
        </div>
      )}
      {open != null && (
        <ProposalDrawer slug={slug} id={open} version={s?.version ?? null} onClose={() => setOpen(null)} onChanged={reload}
          onDone={(ok, v) => {
            setOpen(null); toast(ok ? `Zatwierdzono propozycję${v ? ` · strategia v${v}` : ""}` : "Odrzucono propozycję", 3000); reload();
            if (ok) refresh?.(); // an approved import adds transactions: net worth and Przegląd follow (F7 FE7)
          }} />
      )}
    </div>
  );
}
