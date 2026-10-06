// Ustawienia > Konektory (design/v3/connectors section 2): every installed connector (global list), what needs
// the owner's approval first; the buttons open the connector drawer. A sync proposal opened from a binding
// row shows in the proposal drawer here.
import { useState } from "react";
import { useAsync } from "../hooks";
import { ck } from "../swr";
import { Notice, Skeleton, Tag } from "../ui";
import { changedSinceApproval, CONNECTORS_DOCS_URL, KIND_LABEL, MODULE_LABEL, rowLine, sortConnectors } from "./connectors";
import { ConnectorDrawer, StatusTag } from "./ConnectorDrawer";
import { getConnectors } from "./connectorsApi";
import { useShell } from "./context";
import { plural } from "./messages";
import { ProposalDrawer } from "./ProposalDrawer";
import { useToast } from "../ui";

export function ConnectorsSection() {
  const { slug, system, refresh } = useShell();
  const toast = useToast();
  const [tick, setTick] = useState(0);
  // the list is global, the cache holds one profile at a time: keyed under the active slug
  const list = useAsync(() => getConnectors(), [tick], { key: ck(slug, "connectors") });
  const [open, setOpen] = useState<string | null>(null);
  const [proposal, setProposal] = useState<number | null>(null);
  const data = list.data ? sortConnectors(list.data) : null;
  const waiting = (data ?? []).filter((c) => c.status === "pending" || c.status === "changed").length;
  const changed = () => setTick((n) => n + 1);

  return (
    <section className="card chart-card" id="set-connectors" aria-labelledby="set-connectors-h">
      <h2 id="set-connectors-h">Konektory</h2>
      {data && data.length > 0 && (
        <div className="controls" style={{ margin: "0 0 6px" }}>
          <Tag>{plural(data.length, "konektor", "konektory", "konektorów")}</Tag>
          {waiting > 0 && <Tag tone="warn" solid>{waiting} do zatwierdzenia</Tag>}
          <span className="spacer" />
          <button className="btn" onClick={list.reload} disabled={list.loading || list.refreshing}>Odśwież</button>
        </div>
      )}
      {system?.connectors?.sandbox === false && (
        <Notice tone="warn">Konektory działają tylko w aplikacji na macOS (brak piaskownicy).</Notice>
      )}
      {list.error && <Notice tone="neg">Nie udało się pobrać konektorów: {list.error}</Notice>}
      {!data && !list.error && <>{[0, 1, 2].map((k) => <Skeleton key={k} h={40} style={{ margin: "6px 0" }} />)}</>}
      {data && !data.length && (
        <div className="empty" style={{ textAlign: "left", padding: "8px 0" }}>
          <div style={{ color: "var(--text)", fontWeight: 600 }}>Brak konektorów</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            Importer innego banku albo brokera pisze Claude Code (skill <code>/import-builder</code> w workspace agenta) i zgłasza go tutaj do zatwierdzenia.{" "}
            <a className="lnk" href={CONNECTORS_DOCS_URL} target="_blank" rel="noopener noreferrer">Jak działa konektor</a>
          </div>
        </div>
      )}
      {(data ?? []).map((c) => (
        <div className="row" key={c.id} data-connector={c.id}>
          <div className="grow">
            <div className="t">
              {c.name}
              <Tag>{MODULE_LABEL[c.module] ?? c.module}</Tag>
              <Tag>{KIND_LABEL[c.kind] ?? c.kind}</Tag>
              <StatusTag status={c.status} />
              {c.status === "disabled" && c.content_changed && <Tag tone="neg" title="Pliki różnią się od zatwierdzonych">zmieniony</Tag>}
              {c.source === "mcp" && <Tag title="Zgłoszony przez agenta (propose_connector)">agent</Tag>}
            </div>
            <div className="d">{rowLine(c)}</div>
          </div>
          {c.status === "pending" ? <button className="btn primary" onClick={() => setOpen(c.id)}>Przejrzyj i zatwierdź</button>
            : changedSinceApproval(c) ? <button className="btn primary" onClick={() => setOpen(c.id)}>Sprawdź zmiany</button>
              : <button className="btn" onClick={() => setOpen(c.id)}>Szczegóły</button>}
        </div>
      ))}
      <div className="foot">Konektor działa dopiero po zatwierdzeniu, w piaskownicy, z limitem czasu; każda zmiana plików wymaga ponownego zatwierdzenia.</div>
      {open && (
        <ConnectorDrawer id={open} onClose={() => setOpen(null)} onChanged={changed}
          onProposal={(pid) => { setOpen(null); setProposal(pid); }} />
      )}
      {proposal != null && (
        <ProposalDrawer slug={slug} id={proposal} version={null} onClose={() => setProposal(null)} onChanged={changed}
          onDone={(approved) => { setProposal(null); toast(approved ? "Zaimportowano" : "Odrzucono", 3000); if (approved) refresh?.(); changed(); }} />
      )}
    </section>
  );
}
