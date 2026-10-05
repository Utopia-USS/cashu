// Strategy status pieces (the tag and the details: validation, inactive rules, versions, pending proposals),
// shown in Ustawienia > Agent AI since v2 (no strategy pill on the investments page).
import { useState } from "react";
import { describeIssue, proposalSummary } from "../../core/messages";
import { copyText, Tag, useToast } from "../../ui";
import type { Proposal, StrategyStatus } from "./api";
import { dmy, money0, nBuckets, nRules, plural } from "./labels";

export function strategyTag(st: { state: string; errors: number; warnings: number; inactive_rules: number } | null) {
  if (!st || st.state === "missing") return <Tag tone="warn">brak</Tag>;
  // "partial": every error sits in an inactive rule (skipped), the rest of the strategy works.
  if (st.state === "invalid") return <Tag tone="neg">{plural(st.errors || 1, "błąd", "błędy", "błędów")}</Tag>;
  const w = st.warnings + st.inactive_rules;
  return w ? <Tag tone="warn">{plural(w, "ostrzeżenie", "ostrzeżenia", "ostrzeżeń")}</Tag> : <Tag tone="pos">OK</Tag>;
}

export function StrategyPopover({ st, proposals, onProposal, onInit, onReload }: {
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
