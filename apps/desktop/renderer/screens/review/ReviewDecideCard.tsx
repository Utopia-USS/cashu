import { D } from "@cashu/domain";
import { Amount, DateText } from "@cashu/ui";
import { reviewChoiceLabel } from "./presentation.js";
import { R } from "./Review.strings.js";
import { Rows } from "./ReviewRows.js";
import type { ReviewScreenState } from "./useReviewScreen.js";

const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
export function ReviewDecideCard({ state }: { state: ReviewScreenState }) {
  const session = state.session;
  if (!session) return null;
  const snapshot = session.snapshot;
  return (
    <>
      <Rows rows={state.items} rowKey={(row) => row.key} label={R.decide}>
        {(item) => (
          <section className="grid gap-2">
            <p className="text-sm text-fg-muted">{R[item.group]}</p>
            <h3 className="font-strong">{item.title || R.fix}</h3>
            <p>{item.why}</p>
            {state.detail && (
              <>
                {item.factRows.map((fact) => (
                  <p key={fact.id}>{fact.text}</p>
                ))}
                {item.thesis && (
                  <p>
                    {R.thesis}: {item.thesis}
                  </p>
                )}
                {item.invalidation && (
                  <p>
                    {R.invalidation}: {item.invalidation}
                  </p>
                )}
                {item.exitPlan && (
                  <p>
                    {R.exitPlan}: {item.exitPlan}
                  </p>
                )}
              </>
            )}
            {item.note && (
              <button type="button" className={button} onClick={() => state.setReader(item.note)}>
                {R.fullNote}
              </button>
            )}
            {item.context && <p>{item.context}</p>}
            {item.ladder && item.ladder.count > 1 && (
              <p>
                {R.ladderLevels}: <Amount value={D(String(item.ladder.count))} fractionDigits={0} />{" "}
                · <DateText value={state.dates.ladders[item.key] ?? null} />
              </p>
            )}
            {session.choices[item.key] ? (
              <p>
                {R.choices}: {reviewChoiceLabel(session.choices[item.key] ?? "")}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {item.actions.map(({ action, label }) => (
                  <button
                    type="button"
                    key={action}
                    className={button}
                    disabled={state.pending !== null || state.unknownItems.has(item.key)}
                    onClick={() => void state.choose(item, action)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </Rows>
      <p>
        {R.more}: <Amount value={D(String(snapshot.decide.more))} fractionDigits={0} />
      </p>
      <p>
        {R.unchanged}: <Amount value={D(String(snapshot.decide.rest.review))} fractionDigits={0} />
      </p>
      <p>
        {R.researchRest}:{" "}
        <Amount value={D(String(snapshot.decide.rest.research))} fractionDigits={0} />
      </p>
    </>
  );
}
