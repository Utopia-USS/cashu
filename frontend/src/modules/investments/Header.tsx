// Workspace header row: account filter, freshness, NBP date, strategy pill + popover, and the
// three actions (Uruchom reguły, Import, Przegląd tygodnia).
import { useState } from "react";
import { describeIssue, proposalSummary } from "../../core/messages";
import { copyText, Pop, Seg, Tag, useToast } from "../../ui";
import type { AccountRow, Overview, Proposal, StrategyStatus } from "./api";
import { accountLabel, dm, dmy, money0, nBuckets, nChanges, nRules, plural, wdm } from "./labels";

export function strategyTag(st: { state: string; errors: number; warnings: number; inactive_rules: number } | null) {
  if (!st || st.state === "missing") return <Tag tone="warn">brak</Tag>;
  // "partial": every error sits in an inactive rule (skipped), the rest of the strategy works.
  if (st.state === "invalid") return <Tag tone="neg">{plural(st.errors || 1, "błąd", "błędy", "błędów")}</Tag>;
  const w = st.warnings + st.inactive_rules;
  return w ? <Tag tone="warn">{plural(w, "ostrzeżenie", "ostrzeżenia", "ostrzeżeń")}</Tag> : <Tag tone="pos">OK</Tag>;
}

export function WorkspaceHeader(p: {
  accounts: AccountRow[];
  filter: number | null;
  onFilter: (id: number | null) => void;
  overview: Overview | null;
  hasData: boolean;
  strategy: StrategyStatus | null;
  proposals: Proposal[];
  runBusy: boolean;
  canRun: boolean;
  onRun: () => void;
  onImport: () => void;
  onAddTxn: () => void;
  review: { open: boolean; due: boolean; changes: number; doneToday: string | null };
  onReview: () => void;
  onProposal: (id: number) => void;
  onStrategyInit: () => void;
  onStrategyReload: () => void;
  onWarnings: () => void;
}) {
  const [pop, setPop] = useState(false);
  const fr = p.overview?.freshness;
  const stale = fr?.prices.stale_count ?? 0;
  const brief = p.strategy ?? fr?.strategy ?? null;
  const inactive = p.strategy ? p.strategy.inactive_rules.length : fr?.strategy.inactive_rules ?? 0;
  const tagBrief = brief ? { state: brief.state, errors: brief.errors, warnings: brief.warnings, inactive_rules: inactive } : null;
  const staleNames = fr?.prices.stale.map((s) => `${s.label}: ${s.price_date ? `ostatnie notowanie ${dm(s.price_date)}` : "brak notowań"}`).join("\n");
  return (
    <div className="wshead">
      <h2>Inwestycje</h2>
      {p.accounts.length > 0 && (
        <Seg<number | null> items={[["Wszystkie", null], ...p.accounts.map((a) => [accountLabel(a, p.accounts), a.id] as [string, number])]}
          value={p.filter} onChange={p.onFilter} />
      )}
      {!p.hasData || !fr?.prices.newest_bar ? (
        <Tag>{p.hasData ? "brak notowań - uruchom reguły" : "brak cen - brak pozycji"}</Tag>
      ) : (
        <button className={`tag ${stale ? "warn" : ""} clickable`} style={{ background: "transparent", font: "inherit", fontSize: 11 }}
          title={staleNames || "Wszystkie ceny aktualne"} onClick={p.onWarnings}>
          ceny: {wdm(fr.prices.newest_bar)}{stale ? ` · ${stale} nieaktualne` : ""}
        </button>
      )}
      {p.hasData && fr?.fx.newest_rate && <Tag title="Najnowszy kurs NBP w bazie">NBP: {dm(fr.fx.newest_rate)}</Tag>}
      <div className="menu-anchor">
        <button className={`btn ${pop ? "on" : ""}`} style={{ display: "inline-flex", gap: 8, alignItems: "center" }} aria-expanded={pop} aria-haspopup="dialog"
          onClick={() => setPop((v) => !v)}>
          Strategia{brief?.version != null ? ` v${brief.version}` : ""} {strategyTag(tagBrief)}
          {p.proposals.length > 0 && <Tag tone="info">{plural(p.proposals.length, "propozycja", "propozycje", "propozycji")}</Tag>}
        </button>
        <Pop open={pop} onClose={() => setPop(false)} label="Strategia">
          <StrategyPopover st={p.strategy} proposals={p.proposals} onProposal={(id) => { setPop(false); p.onProposal(id); }}
            onInit={() => { setPop(false); p.onStrategyInit(); }} onReload={p.onStrategyReload} />
        </Pop>
      </div>
      <span className="spacer" />
      <button className="btn" onClick={p.onRun} disabled={p.runBusy || !p.canRun}
        title={p.canRun ? "Wycena, alokacja i reguły teraz (współdzieli blokadę z pracą w tle)" : "Reguły wymagają strategii i co najmniej jednej wyceny"}>
        {p.runBusy ? "Uruchamiam…" : "Uruchom reguły"}
      </button>
      <button className="btn" onClick={p.onImport} title="Import transakcji (i)">Import</button>
      {!p.hasData ? (
        <button className="btn" onClick={p.onAddTxn}>Dodaj transakcję</button>
      ) : (
        <>
          {p.review.doneToday && !p.review.open && <Tag tone="pos">zrobiony {dm(p.review.doneToday)}</Tag>}
          <button className={`btn ${p.review.open || p.review.due ? "primary" : ""}`} onClick={p.onReview} title="Tryb przeglądu tygodnia (r)">
            {p.review.open ? "Zamknij tryb przeglądu" : p.review.due && p.review.changes > 0 ? `Przegląd tygodnia · ${nChanges(p.review.changes)}` : "Przegląd tygodnia"}
          </button>
        </>
      )}
    </div>
  );
}

function StrategyPopover({ st, proposals, onProposal, onInit, onReload }: {
  st: StrategyStatus | null; proposals: Proposal[]; onProposal: (id: number) => void; onInit: () => void; onReload: () => void;
}) {
  const toast = useToast();
  const [history, setHistory] = useState(false);
  if (!st) return <div className="muted">Wczytuję strategię…</div>;
  const copyPath = (path: string, name: string) => copyText(path).then(() => toast(`Skopiowano ścieżkę ${name}`, 2000));
  if (st.state === "missing") {
    return (
      <>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}><strong>Strategia</strong><Tag tone="warn">brak</Tag></div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          Cel, horyzont, koszyki i reguły zapisujesz w <code>strategy.yaml</code>, opis słowny w <code>strategy.md</code>. Najprościej przez wywiad
          w Claude Code (<code>/investments-setup</code>) albo z szablonu.
        </div>
        <div className="controls" style={{ margin: "10px 0 0" }}>
          <button className="btn primary" onClick={onInit}>Utwórz z szablonu</button>
          <button className="btn" onClick={() => copyText("/investments-setup").then(() => toast("Skopiowano polecenie skilla", 2000))}>Kopiuj /investments-setup</button>
        </div>
        {proposals.length > 0 && <ProposalNotice proposals={proposals} version={null} onProposal={onProposal} />}
      </>
    );
  }
  const f = st.facts;
  const current = st.versions.find((v) => v.version === st.version) ?? st.versions[0];
  // Errors of inactive rules are listed once, under the inactive rule (partial strategy).
  const inRule = (path: string) => /^rules\[\d+\]/.test(path);
  const errors = st.issues.filter((i) => i.severity === "error" && !(st.state === "partial" && inRule(i.path)));
  const warnings = st.issues.filter((i) => i.severity !== "error");
  const facts = f ? [
    nBuckets(f.buckets.length), nRules(f.rules.length),
    f.contributions ? `wpłaty ${money0(f.contributions.monthly_amount, f.base_currency)} co miesiąc${f.contributions.day_of_month ? ` do ${f.contributions.day_of_month}.` : ""}` : null,
    f.horizon_years ? `horyzont ${plural(f.horizon_years, "rok", "lata", "lat")}` : null,
    `waluta ${f.base_currency}`,
  ].filter(Boolean).join(" · ") : null;
  const line = (n: number | null) => (n ? ` (linia ${n})` : "");
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
        <strong>Strategia{st.version != null ? ` · wersja ${st.version}` : " · bez zapisanej wersji"}</strong>
        {errors.length || st.state === "invalid" ? <Tag tone="neg">{plural(errors.length || 1, "błąd", "błędy", "błędów")}</Tag> : <Tag tone="pos">YAML poprawny</Tag>}
        {st.state === "partial" && st.inactive_rules.length > 0 && <Tag tone="warn">{plural(st.inactive_rules.length, "reguła nieaktywna", "reguły nieaktywne", "reguł nieaktywnych")}</Tag>}
        <span style={{ flex: 1 }} />
        {current?.created_at && <span className="muted" style={{ fontSize: 12 }}>zatwierdzona {dmy(current.created_at)}</span>}
      </div>
      {facts && <div className="muted" style={{ fontSize: 12.5 }}>{facts}</div>}
      {st.read_error && <div className="muted" style={{ fontSize: 12.5, color: "var(--neg)" }}>Nie udało się odczytać pliku: {st.read_error}</div>}
      {(st.issues.length > 0 || st.inactive_rules.length > 0 || st.base_currency_note) && (
        <ul className="vl">
          {errors.map((i, k) => <li key={`e${k}`}><span className="sev action" /><span title={i.message}><b>Błąd:</b> {describeIssue(i).text} <code>{i.path}</code>{line(i.line)}</span></li>)}
          {warnings.map((i, k) => <li key={`w${k}`}><span className="sev review" /><span title={i.message}><b>Ostrzeżenie:</b> {describeIssue(i).text}{i.path ? <> <code>{i.path}</code></> : null}{line(i.line)}</span></li>)}
          {st.inactive_rules.map((r) => (
            <li key={`r${r.index}`}><span className="sev resolved" />
              <span>Reguła <code>{r.rule_id ?? `#${r.index + 1}`}</code> nieaktywna: {r.issues.map((i) => describeIssue(i).text).join("; ")}{line(r.line)} - traktowana jak pominięta.</span>
            </li>
          ))}
          {st.base_currency_note && <li><span className="sev review" /><span>Waluta strategii różni się od waluty profilu.</span></li>}
        </ul>
      )}
      {proposals.length > 0 && <ProposalNotice proposals={proposals} version={st.version} onProposal={onProposal} />}
      <div className="controls" style={{ margin: "6px 0 0" }}>
        <button className="btn" onClick={() => copyPath(st.files.yaml, "strategy.yaml")} title={st.files.yaml}>Kopiuj ścieżkę strategy.yaml</button>
        <button className="btn" onClick={() => copyPath(st.files.md, "strategy.md")} title={st.files.md} disabled={!st.files.md_exists}>strategy.md</button>
        <button className="btn" onClick={onReload} title="Wczytaj pliki ponownie i sprawdź">Przeładuj</button>
        <span className="spacer" />
        {st.versions.length > 0 && <button className="lnk" style={{ fontSize: 12 }} onClick={() => setHistory((v) => !v)} aria-expanded={history}>historia wersji ({st.versions.length})</button>}
      </div>
      {history && (
        <table style={{ fontSize: 12.5, marginTop: 6 }}>
          <thead><tr><th>Wersja</th><th>Zapisana</th><th>Stan</th></tr></thead>
          <tbody>
            {st.versions.map((v) => (
              <tr key={v.version}><td>v{v.version}</td><td>{dmy(v.created_at)}</td><td>{v.state === "valid" ? "poprawna" : v.state === "partial" ? `częściowa · ${v.issues} uwag` : v.state === "invalid" ? "błędna" : v.state}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ProposalNotice({ proposals, version, onProposal }: { proposals: Proposal[]; version: number | null; onProposal: (id: number) => void }) {
  const first = proposals[0];
  const what = proposalSummary(first) ?? (first.kind === "strategy" ? "zmiana strategii" : first.kind === "custom_rule" || first.kind === "rule" ? "nowa reguła" : first.kind === "import" ? "import do zatwierdzenia" : first.kind);
  return (
    <div className="notice info" style={{ margin: "8px 0" }}>
      <span className="grow">
        <b>{plural(proposals.length, "propozycja", "propozycje", "propozycji")} od agenta {proposals.length === 1 ? "czeka" : "czekają"}:</b> {what}.
        {first.kind !== "import" && version != null ? ` Zatwierdzenie tworzy wersję ${version + 1}.` : ""}
      </span>
      <button className="btn primary" onClick={() => onProposal(first.id)}>Zobacz</button>
    </div>
  );
}
