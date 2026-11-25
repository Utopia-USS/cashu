// The Strategie tab (ab24ab6 v2/Strategies.tsx + strategies.css): `.strat` grid of the file tree (`.strat-left`
// card), the selected file (`.strat-main` card: crumb head, notes, Markdown preview or numbered source) or the
// "no strategy" empty card, and the status card of the main strategy on the right (`.strat-side`). Pure: every
// text and handler comes from useStrategiesScreen.ts; the status card is mounted by the screen (`side`).
import { Button, Seg, Skeleton, Tag } from "@cashu/ui";
import type { ReactNode } from "react";
import { MarkdownDocument } from "./MarkdownDocument.js";
import type { TagModel, TreeGroup } from "./strategiesModel.js";
import type { StrategiesScreenState } from "./useStrategiesScreen.js";

type Ready = Extract<StrategiesScreenState, { phase: "ready" }>;

const grid =
  "grid items-start gap-3.5 grid-cols-[--spacing(65)_minmax(0,1fr)] max-narrow:grid-cols-1";
const withSide =
  "grid-cols-[--spacing(65)_minmax(0,1fr)_--spacing(80)] max-strat:grid-cols-[--spacing(60)_minmax(0,1fr)]";
const card = "rounded-widget border border-border bg-surface-raised";
/** Tree row button; `on` swaps the transparent background and text colour (one utility each, no order clash). */
const rowButton = "flex w-full cursor-pointer border-0 text-left hover:bg-subtle";
const rowIdle = "bg-transparent text-fg";
const mono = "font-mono";
/** The source's `<code>`: the old global `code { font: 0.92em ui-monospace }` shorthand also reset the
 * line height to `normal`, so the lines sit at 11.5px / normal inside the 12.5px / 1.55 `pre`. */
const sourceCode = "font-mono text-code-ui leading-control [font-variant-ligatures:none]";
/** `padding-left: 22 + depth * 12` of the tree rows. */
const indent = ["pl-5.5", "pl-8.5", "pl-11.5", "pl-14.5", "pl-17.5", "pl-20.5"] as const;
const indentOf = (depth: number) => indent[Math.min(depth, indent.length - 1)];
/** `.strat-ext.md` also matched the Markdown `.md` rule (14.5px, line height 1.65): kept as the old app drew it. */
const ext = {
  md: "bg-info-bg text-info text-md-plus leading-prose",
  yaml: "bg-warning-bg text-warning text-4xs-plus",
  text: "bg-chip text-chip-fg text-4xs-plus",
} as const;

const tag = (t: TagModel) => (
  <Tag key={t.key} tone={t.tone} title={t.title}>
    {t.text}
  </Tag>
);

function Tree({ s }: { s: Ready }) {
  return (
    <nav className="flex flex-col" aria-label={s.listLabel}>
      {s.tree.map((d: TreeGroup, i) => (
        <div key={d.key} className={i > 0 ? "mt-1 border-t border-border pt-1" : ""}>
          <button
            type="button"
            className={`${rowButton} flex-wrap items-center gap-x-1.5 gap-y-1 px-3 py-2 ${d.on ? "bg-chip text-fg" : rowIdle}`}
            onClick={() => s.pick(d.select)}
          >
            <span className="basis-full text-sm-plus font-strong wrap-anywhere">{d.title}</span>
            <span className="flex flex-wrap gap-1">{d.tags.map(tag)}</span>
            {d.description && (
              <span className="basis-full text-xs leading-caption text-fg-muted">
                {d.description}
              </span>
            )}
          </button>
          {d.files === null ? (
            <div
              className={`flex items-center gap-1.5 py-1 pr-3 text-xs-plus text-fg-muted ${mono} ${indent[0]}`}
            >
              {s.noFiles}
            </div>
          ) : (
            d.files.map((r) =>
              r.kind === "dir" ? (
                <div
                  key={r.key}
                  className={`py-1 pr-3 text-xs text-fg-muted ${mono} ${indentOf(r.depth)}`}
                >
                  {r.name}/
                </div>
              ) : (
                <button
                  key={r.key}
                  type="button"
                  className={`${rowButton} items-center gap-1.5 py-1 pr-3 text-xs-plus ${mono} ${indentOf(r.depth)} ${r.on ? "bg-info-bg text-info" : rowIdle}`}
                  onClick={() => s.pick({ id: d.id, path: r.path })}
                >
                  <span className={`rounded-2xs px-1 py-px font-bold tracking-caps ${ext[r.ext]}`}>
                    {r.extText}
                  </span>
                  {r.name}
                </button>
              ),
            )
          )}
        </div>
      ))}
    </nav>
  );
}

function Main({ s }: { s: Ready }) {
  const m = s.main;
  if (m.kind === "none")
    return (
      <section className={`${card} min-h-80 overflow-hidden p-0`}>
        <div className="px-6 py-8 text-center text-md text-fg-muted">
          <div className="font-strong text-fg">{m.title}</div>
          <div className="mt-1 text-sm">{m.hint}</div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" onPress={m.onTemplate}>
              {m.fromTemplate}
            </Button>
            <Button onPress={m.onCopyCommand}>{m.copyCommand}</Button>
          </div>
        </div>
      </section>
    );
  const b = m.body;
  return (
    <section className={`${card} min-h-80 overflow-hidden p-0`}>
      {/* old global `header` rule: space-between and a 14px bottom margin (the spacer does not grow) */}
      <header className="mb-3.5 flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="text-sm-plus wrap-anywhere">
          <strong>{m.crumb}</strong>
          <span className="text-fg-muted"> / {m.path}</span>
        </div>
        <span />
        {m.mode && (
          <Seg
            quiet
            label={m.mode.label}
            items={m.mode.items}
            value={m.mode.value}
            onChange={m.mode.onChange}
          />
        )}
        <Button onPress={m.onCopyPath}>{m.copyPath}</Button>
      </header>
      {m.notExecuted && (
        <div className="border-b border-border bg-subtle px-4 py-2 text-xs-plus text-fg-muted">
          {m.notExecuted}
        </div>
      )}
      {m.issuesNote && (
        <div className="border-b border-border bg-warning-bg px-4 py-2 text-xs-plus text-warning">
          {m.issuesNote}
        </div>
      )}
      <div className="px-7 pt-5 pb-7 max-narrow:p-4">
        {b.kind === "error" ? (
          <div className="text-fg-muted">{b.text}</div>
        ) : b.kind === "loading" ? (
          <Skeleton height={120} />
        ) : b.kind === "empty" ? (
          <div className="text-fg-muted">{b.text}</div>
        ) : b.kind === "md" ? (
          <MarkdownDocument text={b.text} />
        ) : (
          <pre className={`-mx-3 my-0 overflow-x-auto text-xs-plus leading-sheet ${mono}`}>
            <code className={sourceCode}>
              {b.lines.map((l) => (
                <span
                  key={l.key}
                  className={`block whitespace-pre pr-3 ${l.tone === "err" ? "bg-negative-bg" : l.tone === "warn" ? "bg-warning-bg" : ""}`}
                  title={l.title}
                >
                  <span className="inline-block w-[--spacing(9.2)] pr-[--spacing(2.875)] text-right text-fg-muted opacity-60 select-none">
                    {l.n}
                  </span>
                  {l.text}
                  {l.issue && (
                    <span
                      className={`block whitespace-normal pt-0.5 pb-1 pl-[--spacing(12.6)] font-sans text-xs ${l.tone === "err" ? "text-negative" : "text-warning"}`}
                    >
                      {l.issue}
                    </span>
                  )}
                </span>
              ))}
            </code>
          </pre>
        )}
      </div>
    </section>
  );
}

/** `side` = the strategy status card (the screen mounts StrategySettings). */
export function StrategiesView({
  state: s,
  side,
}: {
  state: StrategiesScreenState;
  side?: ReactNode;
}) {
  if (s.phase === "unavailable") return <div className={`${card} p-4 text-fg-muted`}>{s.text}</div>;
  return (
    <div className={`${grid} ${s.withSide ? withSide : ""}`} data-testid="native-strategies">
      <aside
        className={`${card} sticky top-3 max-h-screen overflow-auto px-0 py-1.5 max-narrow:static max-narrow:max-h-none`}
      >
        <Tree s={s} />
        <div className="mt-1.5 border-t border-border px-3 pt-2.5 pb-1.5 text-xs leading-cozy text-fg-muted">
          {s.folderHint}{" "}
          <Button variant="link" size="lg" onPress={s.onCopyFolder}>
            {s.copyFolder}
          </Button>
        </div>
      </aside>
      <Main s={s} />
      {s.withSide && <aside className="max-strat:col-span-full">{side}</aside>}
    </div>
  );
}

/** First load (old `<div className="strat"><Skeleton h={320} /><Skeleton h={320} /></div>`). */
export function StrategiesLoadingView() {
  return (
    <div className={grid}>
      <Skeleton height={320} />
      <Skeleton height={320} />
    </div>
  );
}
