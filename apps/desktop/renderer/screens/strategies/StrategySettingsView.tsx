// The investment strategy status card (ab24ab6 v2/StrategySettings.tsx + Header.tsx StrategyPopover /
// ProposalNotice): `.controls` title row with the strategy tag, then a `.card` (12px 14px, 13px) with the status.
// Pure: every text and handler comes from useStrategySettings.ts.
import { Button, Notice, Tag } from "@cashu/ui";
import type { ProposalNoticeModel, TagModel } from "./strategiesModel.js";
import type { StrategySettingsState } from "./useStrategySettings.js";

const card = "rounded-widget border border-border bg-surface-raised px-3.5 py-3 text-sm";
const sev = { action: "bg-negative", review: "bg-warning", resolved: "bg-fg-muted" } as const;
const th =
  "border-b border-border px-1.5 py-2 text-left text-xs font-strong uppercase tracking-column text-fg-muted";
const td = "border-b border-border px-1.5 py-2 text-left";

const tag = (t: TagModel) => (
  <Tag key={t.key} tone={t.tone} title={t.title}>
    {t.text}
  </Tag>
);

function ProposalNotice({
  notice,
  view,
  onOpen,
}: {
  notice: ProposalNoticeModel;
  view: string;
  onOpen(gid: string): void;
}) {
  return (
    <Notice tone="info" className="my-2">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <b>{notice.head}:</b> {notice.what}
        </span>
        <Button variant="primary" onPress={() => onOpen(notice.gid)}>
          {view}
        </Button>
      </div>
    </Notice>
  );
}

export function StrategySettingsView({ state: s }: { state: StrategySettingsState }) {
  const p = s.popover;
  return (
    <div className={s.side ? "" : "mt-4.5"}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <strong className="text-md">{s.title}</strong>
        {tag(s.tag)}
      </div>
      <div className={card}>
        {p.kind === "unavailable" ? (
          <div className="text-fg-muted">{s.unavailableText}</div>
        ) : p.kind === "missing" ? (
          <>
            <div className="mb-1 flex items-center gap-2">
              <strong>{p.strategy}</strong>
              {tag(p.tag)}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button variant="primary" onPress={p.onInit}>
                {p.fromTemplate}
              </Button>
              <Button onPress={p.onCopyCommand}>{p.copyCommand}</Button>
            </div>
            {p.notice && <ProposalNotice notice={p.notice} view={s.view} onOpen={s.onProposal} />}
          </>
        ) : (
          <>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <strong>{p.heading}</strong>
              {p.tags.map(tag)}
              <span className="flex-1" />
              {p.approved && <span className="text-xs text-fg-muted">{p.approved}</span>}
            </div>
            {p.facts && <div className="text-xs-plus text-fg-muted">{p.facts}</div>}
            {p.readError && <div className="text-xs-plus text-negative">{p.readError}</div>}
            {p.showList && (
              <ul className="my-2 list-none p-0">
                {p.items.map((i) => (
                  <li
                    key={i.key}
                    className="flex items-start gap-2 border-b border-border py-1.25 last:border-b-0"
                  >
                    <span
                      className={`mt-1.75 inline-block size-2 flex-none rounded-full ${sev[i.sev]}`}
                    />
                    <span title={i.title}>
                      {i.lead && (
                        <>
                          <b>{i.lead}</b>{" "}
                        </>
                      )}
                      {i.text}
                      {i.code && (
                        <>
                          {" "}
                          <code className="font-mono text-xs">{i.code}</code>
                        </>
                      )}
                      {i.line}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {p.notice && <ProposalNotice notice={p.notice} view={s.view} onOpen={s.onProposal} />}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Button onPress={p.onYaml} title={p.files.yaml}>
                strategy.yaml
              </Button>
              <Button onPress={p.onMd} title={p.files.md} disabled={!p.files.md_exists}>
                strategy.md
              </Button>
              <Button onPress={p.onReload} title={p.reloadTitle}>
                {p.reload}
              </Button>
              <span className="flex-1" />
              {p.historyLabel && (
                <Button variant="link" size="sm" onPress={p.onHistory} expanded={p.history}>
                  {p.historyLabel}
                </Button>
              )}
            </div>
            {p.history && (
              <table className="mt-1.5 w-full border-collapse text-xs-plus">
                <thead>
                  <tr>
                    {p.cols.map((c) => (
                      <th key={c} className={th}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {p.versions.map((v) => (
                    <tr key={v.key}>
                      <td className={td}>{v.version}</td>
                      <td className={td}>{v.saved}</td>
                      <td className={td}>{v.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
