// Pure pieces of the research story strip (ab24ab6 research/Story.tsx Mood, AheadDays, NowOutlook,
// ValuationBox) with story.css's effective values. Props are pre-formatted by researchStripModel.ts.
import { S } from "@cashu/i18n/investments/v2/research/Story.strings";
import type { ReactNode } from "react";
import type {
  StoryAheadDay,
  StoryTone,
  StoryTopicRow,
  StoryValuation,
} from "./researchStripModel.js";

// story.css has three values the token scale lacks (proposed tokens, see contract-H3.md): letter spacing .07em
// (`--tracking-section`), line height 1.3 (`--leading-row`) and the 860px breakpoint (written as
// `max-[calc(861px)]`, Tailwind `max-*` being `width <` like the theme's breakpoints).

/** `.st h4`: the strip's section heads. */
export const storyHead =
  "m-0 mb-2 text-2xs font-heavy uppercase tracking-[var(--tracking-section,.07em)] text-fg-muted";

const moodTone: Record<StoryTone, string> = {
  pos: "bg-positive-bg text-positive",
  neg: "bg-negative-bg text-negative",
  warn: "bg-warning-bg text-warning",
  calm: "bg-chip text-chip-fg",
};

/** `.st-mood`: a toned pill with a dot. `className` = layout (margin, alignment). */
export function Mood({
  tone,
  children,
  className = "",
}: {
  tone: StoryTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.25 whitespace-nowrap rounded-full px-2.25 py-px text-xs font-strong before:size-1.5 before:rounded-full before:bg-current before:content-[''] ${moodTone[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** `.st-days`: the coming events, one row per day (companies by topic, own positions bold, then the market). */
export function AheadDays({ days }: { days: StoryAheadDay[] }) {
  return (
    <div>
      {days.map((d) => (
        <div
          key={d.date}
          className="grid grid-cols-[calc(var(--spacing)*18)_minmax(0,1fr)_auto] items-baseline gap-2.5 border-t border-dashed border-border py-1.75 text-sm first:border-t-0"
        >
          <span className="whitespace-nowrap text-xs text-fg-muted">
            <b className="text-sm text-fg">{d.day}</b> {d.weekday}
          </span>
          <div className="grid min-w-0 gap-0.75">
            {d.groups.map((g, k) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the groups of one day keep their order (old key)
              <div key={k}>
                <span className={dayTopic}>{g.topic}</span>
                {g.earnings && (
                  <span>
                    {S.results}:{" "}
                    {g.earnings.map((i, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat (old key)
                      <span key={j}>
                        {j ? ", " : ""}
                        <span className={i.mine ? dayMine : "text-fg-muted"}>{i.text}</span>
                      </span>
                    ))}
                  </span>
                )}
                {g.other.map((i, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: texts can repeat (old key)
                  <span key={`o${j}`}>
                    {g.earnings || j ? " · " : ""}
                    <span className={i.mine ? dayMine : ""}>{i.text}</span>
                  </span>
                ))}
              </div>
            ))}
            {d.market && (
              <div className="text-fg-muted">
                <span className={dayTopic}>{S.marketTopic}</span>
                {d.market}
              </div>
            )}
          </div>
          <span className="whitespace-nowrap text-2xs font-bold text-warning">{d.mine}</span>
        </div>
      ))}
    </div>
  );
}

const dayTopic = "mr-1.5 text-xs font-heavy text-fg-muted after:content-[':']";
const dayMine = "font-heavy text-fg";

/** `.st-nowout div`: the quiet boxes of Teraz / Perspektywa / Wycena. */
const box = "rounded-md bg-subtle px-2.75 py-2.25 text-sm";
/** `.st-nowout b`: the box's small caps label. */
const boxLabel =
  "mb-0.5 block text-2xs uppercase tracking-[var(--tracking-section,.07em)] text-fg-muted";

/** `.st-nowout`: Teraz, Perspektywa and the valuation of an expanded topic; nothing without any of them. */
export function NowOutlook({ t }: { t: StoryTopicRow }) {
  if (!t.now && !t.outlook && !t.valuation) return null;
  return (
    <div className="mb-1 grid w-full grid-cols-[repeat(auto-fit,minmax(calc(var(--spacing)*50),1fr))] gap-2.5 max-[calc(861px)]:grid-cols-1">
      {t.now && (
        <div className={box}>
          <b className={boxLabel}>{S.now}</b>
          {t.now}
        </div>
      )}
      {t.outlook && (
        <div className={box}>
          <b className={boxLabel}>{S.outlook}</b>
          {t.outlook}
        </div>
      )}
      {t.valuation && <ValuationBox v={t.valuation} />}
    </div>
  );
}

/** `.st-val`: the verdict word, one sentence, then where the figures come from. */
function ValuationBox({ v }: { v: StoryValuation }) {
  return (
    <div className={box}>
      <b className={boxLabel}>{S.valuation}</b>
      {v.word && (
        <Mood tone={v.tone} className="mr-1">
          {v.word}
        </Mood>
      )}{" "}
      {v.sentence}
      <small className="mt-1 block text-2xs text-fg-muted">{v.from}</small>
    </div>
  );
}
