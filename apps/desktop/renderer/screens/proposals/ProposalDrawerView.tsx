// The agent / connector proposal drawer (ab24ab6 core/ProposalDrawer.tsx) in the shared side Drawer (600px):
// kind tag, notices, summary and submitted line, the agent's reason (`.thesis`), the diff blocks (`.diff`), the
// backtest notice, the import facts (`.kv`) and the foot; Reject / Approve in the drawer foot while pending.
import { Button, Drawer, Notice, Tag } from "@cashu/ui";
import type { DiffBlockModel, ProposalDrawerModel } from "./proposalDrawerModel.js";

const kvKey = "text-sm text-fg-muted";
const kvValue = "flex min-w-0 flex-wrap items-center gap-2";
const tone = { add: "text-positive", del: "text-negative" } as const;

function DiffBlock({ block }: { block: DiffBlockModel }) {
  return (
    <>
      <h4 className="mt-2.5 mb-1.5 text-xs uppercase tracking-column text-fg-muted">
        {block.title}
      </h4>
      <section
        aria-label={block.title}
        className="max-h-105 overflow-auto whitespace-pre-wrap rounded-control border border-border bg-chip px-2.5 py-2 font-mono text-xs leading-normal"
      >
        {block.lines.map((l) => (
          <div key={l.key} className={l.tone ? tone[l.tone] : undefined}>
            {l.text}
          </div>
        ))}
      </section>
    </>
  );
}

export function ProposalDrawerView({ m, onClose }: { m: ProposalDrawerModel; onClose(): void }) {
  const f = m.importFacts;
  return (
    <Drawer
      title={m.title}
      label={m.title}
      width={600}
      tag={m.tag ? <Tag tone="info">{m.tag}</Tag> : undefined}
      onClose={onClose}
      footer={
        m.pending ? (
          <>
            <Button disabled={m.busy} onPress={m.onReject}>
              {m.reject}
            </Button>
            <span className="flex-1" />
            <Button variant="primary" disabled={m.approveDisabled} onPress={m.onApprove}>
              {m.approve}
            </Button>
          </>
        ) : undefined
      }
    >
      {m.error && (
        <Notice tone="negative">
          <span title={m.error.detail ?? undefined}>{m.error.text}</span>
        </Notice>
      )}
      {m.failedNotice && (
        <Notice tone="negative">
          <span title={m.failedNotice.detail ?? undefined}>{m.failedNotice.text}</span>
        </Notice>
      )}
      {m.notFound ? (
        <div className="text-fg-muted">{m.notFound}</div>
      ) : (
        <>
          <div className="mb-1 font-strong">{m.summary}</div>
          <div className="mb-2.5 text-xs-plus text-fg-muted">{m.meta}</div>
          {m.detailError && <Notice tone="warning">{m.detailError}</Notice>}
          {m.unsupported && <Notice tone="warning">{m.unsupported}</Notice>}
          {m.baseChanged && <Notice tone="warning">{m.baseChanged}</Notice>}
          {m.reason && (
            <div className="mb-3 border-l-2 border-border pl-2.5 text-xs-plus leading-widget text-fg-muted">
              <b className="font-strong text-fg">{m.reason.lead}</b> {m.reason.text}
            </div>
          )}
          {m.diffs.map((d) => (
            <DiffBlock key={d.title} block={d} />
          ))}
          {m.backtest && (
            <Notice tone="info" className="mt-3 mb-0">
              {m.backtest}
            </Notice>
          )}
          {f && (
            <div className="mt-1 mb-2.5 grid grid-cols-[--spacing(37.5)_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-md">
              {f.connector && (
                <>
                  <span className={kvKey}>{f.connector.label}</span>
                  <span className={kvValue}>
                    {f.connector.name} <Tag>{f.connector.tag}</Tag>
                    {f.connector.since && (
                      <span className="text-xs text-fg-muted">{f.connector.since}</span>
                    )}
                  </span>
                </>
              )}
              {f.file && (
                <>
                  <span className={kvKey}>{f.file.label}</span>
                  <span className={kvValue}>
                    <code className="font-mono text-xs wrap-anywhere">{f.file.value}</code>
                  </span>
                </>
              )}
              <span className={kvKey}>{f.account.label}</span>
              <span className={kvValue}>{f.account.value}</span>
              {f.preview && (
                <>
                  <span className={kvKey}>{f.preview.label}</span>
                  <span className={kvValue}>{f.preview.value}</span>
                </>
              )}
            </div>
          )}
          {m.accountFacts && (
            <div className="mt-1 mb-2.5 grid grid-cols-[--spacing(37.5)_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-md">
              <span className={kvKey}>{m.accountFacts.account.label}</span>
              <span className={kvValue}>{m.accountFacts.account.value}</span>
              <span className={kvKey}>{m.accountFacts.effect.label}</span>
              <span className={kvValue}>{m.accountFacts.effect.value}</span>
            </div>
          )}
          <div className="mt-2.5 text-xs-plus text-fg-muted">{m.foot}</div>
        </>
      )}
    </Drawer>
  );
}
