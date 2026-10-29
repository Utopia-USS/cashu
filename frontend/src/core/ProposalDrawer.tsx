// The agent / connector proposal drawer (moved from the investments module, design/v3/connectors section 6):
// strategy, rule and import proposals of the agent, and the connector sync proposals (`import` with
// `source: connector`, `budget_import`). Approve / reject; a refused approval shows why.
import { useAsync } from "../hooks";
import { Drawer, Notice, Skeleton, Tag } from "../ui";
import { describeError, proposalError, proposalSummary } from "./messages";
import { approveProposal, getProposal, rejectProposal } from "./proposalsApi";
import { dm, dmy } from "../modules/investments/labels";
import { S } from "./ProposalDrawer.strings.ts";
import { useState } from "react";

const errText = (e: unknown) => describeError(e).text;

export function ProposalDrawer({ slug, id, version, onClose, onDone, onChanged }: {
  slug: string; id: number; version: number | null; onClose: () => void; onDone: (approved: boolean, newVersion: number | null) => void;
  onChanged?: () => void;
}) {
  const p = useAsync(() => getProposal(slug, id), [slug, id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const data = p.data;
  const act = async (approve: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = approve ? await approveProposal(slug, id) : await rejectProposal(slug, id);
      const v = r.result && typeof r.result.version === "number" ? (r.result.version as number) : null;
      onDone(approve, v);
    } catch (e) {
      setErr(errText(e));
      p.reload(); // a refused approval marks the proposal failed: show its new status
      onChanged?.();
    } finally { setBusy(false); }
  };
  const budgetImport = data?.kind === "budget_import";
  const isImport = data?.kind === "import" || budgetImport;
  const failure = proposalError(data?.result); // why applying failed (stable error_code -> label)
  const kindLabel = !data ? "" : budgetImport ? S.kindBudgetImport : isImport ? S.kindImport : data.kind === "strategy" ? S.kindStrategy : S.kindRule;
  // A connector sync (contract C8): the payload names the connector and the `since` of the fetch.
  const payload = (data?.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const fromConnector = payload.source === "connector" || data?.source === "connector";
  const connectorName = str(data?.connector_name) ?? str(payload.connector_name);
  const since = str(data?.since) ?? str(payload.since);
  const yamlDiff = typeof data?.diff === "string" ? data.diff : data?.diff?.yaml ?? null;
  const mdDiff = typeof data?.diff === "object" && data?.diff ? data.diff.md ?? null : null;
  const bt = data?.backtest;
  const pv = data?.preview;
  const unsupported = !!data?.converter_unsupported; // a converter script proposal from before connectors: never runs
  return (
    <Drawer open title={S.title} tag={data ? <Tag tone="info">{kindLabel}</Tag> : undefined}
      width={600} onClose={onClose} label={S.title}
      footer={data?.status === "pending" ? <>
        <button className="btn" disabled={busy} onClick={() => act(false)}>{S.reject}</button>
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || unsupported} onClick={() => act(true)}>{isImport ? S.approveImport : S.approveAs((version ?? 0) + 1)}</button>
      </> : undefined}>
      {err && <Notice tone="neg">{failure ? <span title={failure.detail ?? undefined}>{failure.text}</span> : err}</Notice>}
      {!err && data?.status === "failed" && failure && <Notice tone="neg"><span title={failure.detail ?? undefined}>{failure.text}</span></Notice>}
      {p.error && <Notice tone="neg">{S.loadFailed(p.error)}</Notice>}
      {!data && !p.error && <Skeleton h={160} />}
      {data && (
        <>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{proposalSummary(data) ?? S.changeProposal}</div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            {data.created_at ? S.submitted(dmy(data.created_at)) : ""}
            {data.status !== "pending" ? ` · ${({ approved: S.approved, rejected: S.rejected, failed: S.failed } as Record<string, string>)[data.status] ?? data.status}` : ""}
          </div>
          {data.detail_error && !unsupported && <Notice tone="warn">{data.detail_error}</Notice>}
          {unsupported && <Notice tone="warn">{S.unsupported}</Notice>}
          {data.base_changed && <Notice tone="warn">{S.baseChanged}</Notice>}
          {data.reason && <div className="thesis" style={{ marginBottom: 12 }}><b>{S.agentReason}</b> {data.reason}</div>}
          {yamlDiff && <DiffBlock title={S.yamlChange} text={yamlDiff} />}
          {mdDiff && <DiffBlock title={S.mdChange} text={mdDiff} />}
          {!yamlDiff && data.rule_yaml && <DiffBlock title={S.newRule} text={data.rule_yaml} />}
          {bt && (
            <Notice tone="info" style={{ margin: "12px 0 0" }}>
              {bt.evaluated
                ? <>{S.backtest(`${bt.from ? dm(bt.from) : ""}${bt.to ? ` - ${dm(bt.to)}` : ""}`, bt.points_fired ?? 0, bt.evaluated, bt.episodes ?? 0)}{bt.last_fired ? S.lastFired(dm(bt.last_fired)) : ""}{bt.instruments?.length ? ` · ${bt.instruments.join(", ")}` : ""}.</>
                : S.noHistory}
            </Notice>
          )}
          {isImport && (
            <>
              <div className="kv" style={{ margin: "4px 0 10px" }}>
                {fromConnector && (
                  <><span className="k">{S.source}</span><span className="v">{connectorName ?? "-"} <Tag>{S.connector}</Tag>{since ? <span className="fhint">{S.since(dm(since))}</span> : null}</span></>
                )}
                {(!fromConnector || data.file_name) && <><span className="k">{S.file}</span><span className="v"><code>{data.file_name ?? "-"}</code></span></>}
                {budgetImport ? (
                  <>
                    <span className="k">{S.account}</span><span className="v">{str(data.account_label) ?? str(payload.account_label) ?? data.account ?? "-"}</span>
                    {pv && <><span className="k">{S.preview}</span><span className="v">{S.newTxns(Number(pv.new ?? 0))} · {S.duplicates(Number(pv.duplicates ?? 0))}{Number(pv.warnings ?? 0) ? ` · ${S.warnings(Number(pv.warnings))}` : ""}</span></>}
                  </>
                ) : <><span className="k">{S.brokerageAccount}</span><span className="v">{data.account ?? "-"}</span></>}
                {pv && !budgetImport && <><span className="k">{S.preview}</span><span className="v">{S.newRows(Number(pv.new ?? 0))} · {S.duplicates(Number(pv.duplicates ?? 0))}{Number(pv.reconciliation_mismatches ?? 0) ? ` · ${S.mismatches(Number(pv.reconciliation_mismatches))}` : ""}{Number(pv.errors ?? 0) ? ` · ${S.errors(Number(pv.errors))}` : ""}</span></>}
              </div>
            </>
          )}
          <div className="foot">{S.rejectChangesNothing}</div>
        </>
      )}
    </Drawer>
  );
}

function DiffBlock({ title, text }: { title: string; text: string }) {
  return (
    <>
      <h4 style={{ margin: "10px 0 6px", fontSize: 12, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.03em" }}>{title}</h4>
      <div className="diff" role="region" aria-label={title}>
        {text.split("\n").map((l, k) => (
          <div key={k} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>{l || " "}</div>
        ))}
      </div>
    </>
  );
}
