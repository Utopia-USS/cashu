// Strategy status pieces (the tag and the details: validation, inactive rules, versions, pending proposals),
// shown in Ustawienia > Agent AI since v2 (no strategy pill on the investments page).
import { useState } from "react";
import { describeIssue, proposalSummary } from "../../core/messages";
import { copyText, Tag, useToast } from "../../ui";
import type { Proposal, StrategyStatus } from "./api";
import { dmy, money0, nBuckets, nRules } from "./labels";
import { S } from "./Header.strings.ts";
import { ruleKindLabel } from "./v2/logic";

export function strategyTag(st: { state: string; errors: number; warnings: number; inactive_rules: number } | null) {
  if (!st || st.state === "missing") return <Tag tone="warn">{S.none}</Tag>;
  // "partial": every error sits in an inactive rule (skipped), the rest of the strategy works.
  if (st.state === "invalid") return <Tag tone="neg">{S.nErrors(st.errors || 1)}</Tag>;
  const w = st.warnings + st.inactive_rules;
  return w ? <Tag tone="warn">{S.nWarnings(w)}</Tag> : <Tag tone="pos">OK</Tag>;
}

export function StrategyPopover({ st, proposals, onProposal, onInit, onReload }: {
  st: StrategyStatus | null; proposals: Proposal[]; onProposal: (id: number) => void; onInit: () => void; onReload: () => void;
}) {
  const toast = useToast();
  const [history, setHistory] = useState(false);
  if (!st) return <div className="muted">{S.loading}</div>;
  const copyPath = (path: string, name: string) => copyText(path).then(() => toast(S.pathCopied(name), 2000));
  if (st.state === "missing") {
    return (
      <>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}><strong>{S.strategy}</strong><Tag tone="warn">{S.none}</Tag></div>
        <div className="controls" style={{ margin: "10px 0 0" }}>
          <button className="btn primary" onClick={onInit}>{S.fromTemplate}</button>
          <button className="btn" onClick={() => copyText("/investments-setup").then(() => toast(S.copied, 2000))}>{S.copyCommand}</button>
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
    f.contributions ? S.contributions(money0(f.contributions.monthly_amount, f.base_currency), f.contributions.day_of_month) : null,
    f.horizon_years ? S.horizon(f.horizon_years) : null,
    S.currency(f.base_currency),
  ].filter(Boolean).join(" · ") : null;
  const line = (n: number | null) => (n ? S.line(n) : "");
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
        <strong>{S.strategy}{st.version != null ? ` · v${st.version}` : S.noVersion}</strong>
        {errors.length || st.state === "invalid" ? <Tag tone="neg">{S.nErrors(errors.length || 1)}</Tag> : <Tag tone="pos">{S.yamlValid}</Tag>}
        {st.state === "partial" && st.inactive_rules.length > 0 && <Tag tone="warn">{S.nInactive(st.inactive_rules.length)}</Tag>}
        <span style={{ flex: 1 }} />
        {current?.created_at && <span className="muted" style={{ fontSize: 12 }}>{S.approved(dmy(current.created_at))}</span>}
      </div>
      {facts && <div className="muted" style={{ fontSize: 12.5 }}>{facts}</div>}
      {st.read_error && <div className="muted" style={{ fontSize: 12.5, color: "var(--neg)" }}>{S.readError} {st.read_error}</div>}
      {(st.issues.length > 0 || st.inactive_rules.length > 0 || st.base_currency_note) && (
        <ul className="vl">
          {errors.map((i, k) => <li key={`e${k}`}><span className="sev action" /><span title={i.message}><b>{S.error}</b> {describeIssue(i).text} <code>{i.path}</code>{line(i.line)}</span></li>)}
          {warnings.map((i, k) => <li key={`w${k}`}><span className="sev review" /><span title={i.message}><b>{S.warning}</b> {describeIssue(i).text}{i.path ? <> <code>{i.path}</code></> : null}{line(i.line)}</span></li>)}
          {st.inactive_rules.map((r) => (
            <li key={`r${r.index}`}><span className="sev resolved" />
              {/* The rule's position and kind (and its YAML line), never its strategy id (FE-A A6). */}
              <span>{S.ruleInactive(r.index + 1, ruleKindLabel(r.kind), r.issues.map((i) => describeIssue(i).text).join("; "))}{line(r.line)}</span>
            </li>
          ))}
          {st.base_currency_note && <li><span className="sev review" /><span>{S.currencyDiffers}</span></li>}
        </ul>
      )}
      {proposals.length > 0 && <ProposalNotice proposals={proposals} version={st.version} onProposal={onProposal} />}
      <div className="controls" style={{ margin: "6px 0 0" }}>
        <button className="btn" onClick={() => copyPath(st.files.yaml, "strategy.yaml")} title={st.files.yaml}>strategy.yaml</button>
        <button className="btn" onClick={() => copyPath(st.files.md, "strategy.md")} title={st.files.md} disabled={!st.files.md_exists}>strategy.md</button>
        <button className="btn" onClick={onReload} title={S.reloadTitle}>{S.reload}</button>
        <span className="spacer" />
        {st.versions.length > 0 && <button className="lnk" style={{ fontSize: 12 }} onClick={() => setHistory((v) => !v)} aria-expanded={history}>{S.history(st.versions.length)}</button>}
      </div>
      {history && (
        <table style={{ fontSize: 12.5, marginTop: 6 }}>
          <thead><tr><th>{S.colVersion}</th><th>{S.colSaved}</th><th>{S.colState}</th></tr></thead>
          <tbody>
            {st.versions.map((v) => (
              <tr key={v.version}><td>v{v.version}</td><td>{dmy(v.created_at)}</td><td>{v.state === "valid" ? S.stateValid : v.state === "partial" ? S.statePartial(v.issues) : v.state === "invalid" ? S.stateInvalid : v.state}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ProposalNotice({ proposals, version, onProposal }: { proposals: Proposal[]; version: number | null; onProposal: (id: number) => void }) {
  const first = proposals[0];
  const what = proposalSummary(first) ?? (first.kind === "strategy" ? S.propStrategy : first.kind === "custom_rule" || first.kind === "rule" ? S.propRule : first.kind === "import" ? S.propImport : first.kind);
  return (
    <div className="notice info" style={{ margin: "8px 0" }}>
      <span className="grow">
        <b>{proposals.length > 1 ? S.proposals(proposals.length) : S.proposal}:</b> {what}
      </span>
      <button className="btn primary" onClick={() => onProposal(first.id)}>{S.view}</button>
    </div>
  );
}
