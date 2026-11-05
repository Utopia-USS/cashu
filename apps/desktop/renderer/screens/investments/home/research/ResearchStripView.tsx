// The research strip, the last cell of the investments Home (ab24ab6 research/Story.tsx ResearchStory with
// story.css): one sentence on the market, the macro regimes as chips (a click explains), what is coming up,
// the theses that lost ground and one line per topic (a click opens Teraz / Perspektywa and the notes).
// Pure: every string comes pre-formatted from researchStripModel.ts; only which chip / topic is open lives here.

import { S as M } from "@cashu/i18n/investments/v2/research/MacroWidgets.strings";
import { S } from "@cashu/i18n/investments/v2/research/Story.strings";
import { Button, MacroRows, Tag, Widget } from "@cashu/ui";
import { useState } from "react";
import type { MacroStripProps } from "./macroStripModel.js";
import type {
  ResearchHiddenProps,
  ResearchStoryProps,
  ResearchStripProps,
} from "./researchStripModel.js";
import { AheadDays, Mood, NowOutlook, storyHead } from "./storyParts.js";

export function ResearchStripView(props: ResearchStripProps) {
  switch (props.kind) {
    case "story":
      return <ResearchStory {...props} />;
    case "macro":
      return <MacroStrip {...props} />;
    case "hidden":
      return <ResearchHidden {...props} />;
  }
}

/** Privacy mode: the strip's frame with the hidden line instead of the research text. */
function ResearchHidden(p: ResearchHiddenProps) {
  return (
    <Widget
      title={S.research}
      id="inv-research"
      tight
      controls={
        <Button variant="link" onPress={p.onAll}>
          {p.allLabel}
        </Button>
      }
    >
      <div className="text-sm text-fg-muted">{p.text}</div>
    </Widget>
  );
}

/** Old MacroWidgets MacroStrip (the Home before the first research run): the five regimes side by side. */
function MacroStrip(p: MacroStripProps) {
  return (
    <Widget
      title={p.label}
      id="inv-macro"
      tight
      tags={p.asOf ? <Tag title={p.asOf.title}>{p.asOf.text}</Tag> : undefined}
    >
      <MacroRows label={p.label} rows={p.rows} />
    </Widget>
  );
}

function ResearchStory(p: ResearchStoryProps) {
  const [openMacro, setOpenMacro] = useState<string | null>(null);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const opened = p.chips.find((c) => c.key === openMacro);
  return (
    <Widget
      title={S.research}
      id="inv-research"
      count={p.count}
      tight
      controls={
        <Button variant="link" onPress={p.onAll}>
          {p.allLabel}
        </Button>
      }
    >
      <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-7 max-story:grid-cols-1 max-story:gap-4.5">
        <div>
          {p.lead && (
            <p className="m-0 mb-3 text-balance text-3xl font-bold leading-tight tracking-snug max-story:text-xl">
              {p.lead}
            </p>
          )}
          {/* old `div.st-chips role=group`: a fieldset is the semantic group (reset to the div's box) */}
          <fieldset
            className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
            aria-label={M.macro}
          >
            {p.chips.map((c) => (
              <button
                key={c.key}
                type="button"
                data-macro={c.key}
                aria-expanded={openMacro === c.key}
                onClick={() => setOpenMacro(openMacro === c.key ? null : c.key)}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-raised py-0.75 pr-2.5 pl-1 text-xs text-fg aria-expanded:border-accent"
              >
                <Mood tone={c.tone}>{c.state}</Mood>
                <b className="font-strong">{c.label}</b>
                {c.fresh && (
                  <span className="text-3xs font-bold uppercase tracking-label text-accent">
                    {S.newTag}
                  </span>
                )}
              </button>
            ))}
          </fieldset>
          {opened && (
            <div className="mt-2 rounded-md bg-subtle px-2.75 py-2.25 text-sm text-fg-muted">
              {opened.brief ? (
                <>
                  <b className="text-fg">{opened.brief.headline}.</b> {opened.brief.why}
                </>
              ) : (
                opened.plain
              )}{" "}
              <Button variant="link" onPress={opened.onMore}>
                {S.more}
              </Button>
            </div>
          )}
          <div className="mt-4 border-t border-border pt-3">
            <h4 className={storyHead}>{S.ahead}</h4>
            <div className="mb-1.5 text-md font-heavy">{p.aheadSay}</div>
            <AheadDays days={p.days} />
          </div>
        </div>
        <div>
          {p.weak && (
            <div className="mb-3.5 flex items-center gap-3 rounded-widget bg-negative-bg px-3 py-2.25">
              <div className="min-w-0 flex-1">
                <b className="text-negative">{p.weak.title}</b>{" "}
                <span className="text-sm text-fg-muted">{p.weak.names}</span>
              </div>
              <Button onPress={p.weak.onReview}>{S.review}</Button>
            </div>
          )}
          <h4 className={storyHead}>{S.topicsWeek}</h4>
          <div>
            {p.topics.map((t) => (
              <div key={t.key} className="border-t border-border first:border-t-0">
                <button
                  type="button"
                  data-topic={t.key}
                  aria-expanded={openTopic === t.key}
                  onClick={() => setOpenTopic(openTopic === t.key ? null : t.key)}
                  className="group grid w-full cursor-pointer grid-cols-[--spacing(30)_minmax(0,1fr)_auto] items-baseline gap-3 border-0 bg-transparent px-0.5 py-2.5 text-left text-fg max-story:grid-cols-[minmax(auto,1fr)_auto]"
                >
                  <span className="text-xs font-strong text-fg-muted max-story:col-span-full">
                    {t.label}
                  </span>
                  <span className="text-md-plus font-strong leading-row group-hover:text-accent">
                    <Mood tone={t.mood.tone} className="mr-1.5 align-[--spacing(0.25)]">
                      {t.mood.word}
                    </Mood>
                    {t.headline}
                  </span>
                  <span className="whitespace-nowrap text-xs text-fg-muted tabular-nums">
                    {t.impact}
                  </span>
                </button>
                {openTopic === t.key && (
                  <div className="grid justify-items-start gap-1.5 pt-0 pr-0.5 pb-3 pl-33.5 max-story:pl-0.5">
                    <NowOutlook t={t} />
                    {t.notes.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={n.onOpen}
                        className="cursor-pointer border-0 bg-transparent px-0 py-0.5 text-left text-sm text-fg hover:text-accent"
                      >
                        {n.headline} <span className="text-fg-muted">· {n.day}</span>
                      </button>
                    ))}
                    <Button variant="link" onPress={t.onWholeTopic}>
                      {S.wholeTopic}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5 border-t border-border pt-2.5 text-sm">
            {p.quiet && <span className="text-fg-muted">{p.quiet}</span>}
            <span className="flex-1" />
            {p.drafts && (
              <>
                <span>
                  <span className="inline-block min-w-4.5 rounded-full bg-warning-bg px-1.5 text-center text-xs font-bold text-warning">
                    {p.drafts.count}
                  </span>{" "}
                  {p.drafts.text}
                </span>
                <Button onPress={p.drafts.onReview}>{S.reviewDrafts}</Button>
              </>
            )}
          </div>
        </div>
      </div>
    </Widget>
  );
}
