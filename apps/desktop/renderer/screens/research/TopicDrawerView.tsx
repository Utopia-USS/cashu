// The topic drawer over the Home (ab24ab6 v2/research/TopicDrawer.tsx TopicDetail in the asset drawer's panel,
// research.css `.tdw`, `.tz`, `.tview`, `.mrow.solo`): Teza + Instrumenty | Notatki, or a macro regime's state |
// Notatki. Pure: the texts come from topicDrawerModel.ts, the edit state from the screen hook.
import { S as H } from "@cashu/i18n/investments/v2/AssetDrawer.strings";
import { S } from "@cashu/i18n/investments/v2/research/TopicDrawer.strings";
import {
  BriefList,
  Button,
  DetailDrawer,
  InstLabel,
  MacroMetrics,
  Tag,
  TextField,
  Widget,
} from "@cashu/ui";
import { Fragment, useId } from "react";
import { NoteRowItem } from "../investments/asset/NoteRowItem.js";
import type { RegimeModel, ThesisModel, TopicDrawerModel, TopicEdit } from "./topicDrawerModel.js";

export interface TopicDrawerActions {
  onClose(): void;
  /** The crumb: `home` = Inwestycje, `section` = Tematy / Makro (close and scroll to the research strip). */
  onCrumb(where: "home" | "section"): void;
  onEdit(): void;
  onCancel(): void;
  onField(key: keyof TopicEdit, value: string): void;
  onSave(): void;
  onConfirm(): void;
}

const empty = "text-sm text-fg-muted";

const regimeTone = {
  positive: "positive",
  negative: "negative",
  warning: "warning",
  neutral: "neutral",
} as const;

function RegimeState({ r }: { r: RegimeModel | null }) {
  if (!r)
    return (
      <Widget title={S.state} tight>
        <div className={empty}>{S.noMacroData}</div>
      </Widget>
    );
  return (
    <Widget
      title={S.state}
      id="topic-regime"
      tight
      tags={
        <>
          {r.states.map((s) => (
            <Tag key={s.text} tone={regimeTone[s.tone]}>
              {s.text}
            </Tag>
          ))}
          {r.since && <span className="text-xs-plus font-medium text-fg-muted">{r.since}</span>}
        </>
      }
    >
      <div className="text-sm">
        <div className="mt-0.75 text-sm font-strong leading-cozy text-fg">{r.headline}</div>
        {r.why && <div className="mt-0.5 text-xs-plus leading-widget text-fg-muted">{r.why}</div>}
        {r.supports && <BriefList label={r.supports.label} items={r.supports.items} tone="sup" />}
        {r.risks && <BriefList label={r.risks.label} items={r.risks.items} tone="rsk" />}
        {r.explain && (
          <p className="mt-2 mb-0 text-xs-plus leading-normal text-fg-muted">{r.explain}</p>
        )}
        {r.metrics.length > 0 && <MacroMetrics metrics={r.metrics} />}
        {r.researchOn && <div className="mt-1.5 text-2xs-plus text-fg-muted">{r.researchOn}</div>}
      </div>
    </Widget>
  );
}

function FormField({
  f,
  onField,
}: {
  f: NonNullable<ThesisModel["form"]>["fields"][number];
  onField: TopicDrawerActions["onField"];
}) {
  const id = useId();
  return (
    <div className="grid gap-1 [&+&]:mt-2">
      <label htmlFor={id} className="mb-0.75 block text-2xs font-strong text-fg-muted">
        {f.label}
      </label>
      <TextField
        id={id}
        label={f.label}
        labelHidden
        multiline
        rows={f.rows}
        maxLength={f.max}
        value={f.value}
        onChange={(v) => onField(f.key, v)}
      />
    </div>
  );
}

const viewLabel = "mb-0.5 block text-3xs-plus font-bold uppercase tracking-caps text-accent";
const viewText = "m-0 whitespace-pre-wrap text-xs-plus leading-widget text-fg";

function ThesisWidget({ m, topic, a }: { m: ThesisModel; topic: string; a: TopicDrawerActions }) {
  const err = m.err && <div className="text-xs-plus text-negative">{m.err}</div>;
  const v = m.view;
  return (
    <Widget
      title={S.thesis}
      id="topic-thesis"
      tight
      tags={
        m.draftTag ? (
          <Tag tone="warning" title={m.draftTag.title}>
            {m.draftTag.text}
          </Tag>
        ) : undefined
      }
      controls={
        m.controls ? (
          <>
            {m.controls.confirm && (
              <Button variant="primary" size="sm" disabled={m.busy} onPress={a.onConfirm}>
                {m.controls.confirm}
              </Button>
            )}
            <Button size="sm" onPress={a.onEdit}>
              {m.controls.edit}
            </Button>
          </>
        ) : undefined
      }
    >
      {m.form ? (
        <div className="grid gap-3">
          {m.form.fields.map((f) => (
            <FormField key={f.key} f={f} onField={a.onField} />
          ))}
          {err}
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={m.busy} onPress={a.onCancel}>
              {m.form.cancel}
            </Button>
            <Button variant="primary" size="sm" disabled={m.busy} onPress={a.onSave}>
              {m.form.save}
            </Button>
          </div>
        </div>
      ) : v?.kind === "thesis" ? (
        <div>
          <p className="m-0 mb-1.5 whitespace-pre-wrap text-sm leading-widget">{v.thesis}</p>
          {v.invalidation && (
            <p className="m-0 mb-1.5 whitespace-pre-wrap text-sm leading-widget">
              <b className="block text-2xs font-strong uppercase tracking-label text-fg-muted">
                {v.invalidation.label}
              </b>
              {v.invalidation.text}
            </p>
          )}
          {v.market && (
            <div
              data-topic-view={topic}
              className="mt-2 grid gap-1.75 rounded-r-sm border-l-2 border-accent bg-info-bg px-2.25 py-1.5"
            >
              {[v.market.assessment, v.market.outlook].map(
                (x) =>
                  x && (
                    <div key={x.label}>
                      <span className={viewLabel}>{x.label}</span>
                      <p className={viewText}>
                        {x.parts.map((part) =>
                          part.bold ? (
                            <b key={part.key} className="font-strong tabular-nums">
                              {part.text}
                            </b>
                          ) : (
                            part.text
                          ),
                        )}
                      </p>
                    </div>
                  ),
              )}
              {v.market.sources.length > 0 && (
                <div
                  data-view-sources={v.market.sources.length}
                  className="flex flex-wrap gap-x-1.25 gap-y-0.5 text-2xs leading-cozy text-fg-muted"
                >
                  {v.market.sources.map((l, i) => (
                    <Fragment key={`${l.text}${l.href}`}>
                      {i > 0 && <span>·</span>}
                      {l.href ? (
                        <a
                          href={l.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={l.title}
                          className="text-fg-muted underline decoration-border underline-offset-2 hover:text-fg"
                        >
                          {l.text}
                        </a>
                      ) : (
                        <span title={l.title}>{l.text}</span>
                      )}
                    </Fragment>
                  ))}
                </div>
              )}
              {v.market.at && (
                <span className="text-2xs text-fg-muted tabular-nums">{v.market.at}</span>
              )}
            </div>
          )}
          {err}
        </div>
      ) : v?.kind === "empty" ? (
        <div className={empty}>{v.text}</div>
      ) : null}
    </Widget>
  );
}

export function TopicDrawerView({ m, a }: { m: TopicDrawerModel; a: TopicDrawerActions }) {
  const left = m.left;
  return (
    <DetailDrawer
      name={m.crumb.name}
      crumbLabel={H.breadcrumb}
      root={H.investments}
      section={m.crumb.section}
      onCrumb={a.onCrumb}
      onClose={a.onClose}
    >
      <div
        data-topic-drawer={m.key}
        className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start gap-3.5 max-narrow:grid-cols-1"
      >
        <div className="grid min-w-0 gap-3.5">
          {left.kind === "regime" ? (
            <RegimeState r={left.regime} />
          ) : (
            <>
              <ThesisWidget m={left.thesis} topic={m.key} a={a} />
              <Widget title={S.instruments} id="topic-members" count={left.members.count} tight>
                {!left.members.items.length ? (
                  <div className={empty}>{S.noInstruments}</div>
                ) : (
                  <div className="grid gap-2">
                    {left.members.items.map((x) => (
                      <div key={x.symbol} data-member={x.symbol}>
                        <InstLabel
                          density="compact"
                          {...x.tile}
                          name={x.name}
                          onOpen={x.onOpen}
                          sub={x.sub}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </Widget>
            </>
          )}
        </div>
        <Widget title={S.notes} id="topic-notes" count={m.notes.count} tight>
          {!m.notes.rows.length ? (
            <div className={empty}>{S.noNotes}</div>
          ) : (
            m.notes.rows.map((n) => (
              <NoteRowItem
                key={n.id}
                n={n}
                onToggle={n.onToggle}
                onDismiss={n.onDismiss}
                onRestore={n.onRestore}
              />
            ))
          )}
        </Widget>
      </div>
    </DetailDrawer>
  );
}
