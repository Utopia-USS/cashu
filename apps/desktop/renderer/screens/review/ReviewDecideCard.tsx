import { D } from "@cashu/domain";
import { Amount, Button, DateText } from "@cashu/ui";
import { reviewChoiceLabel } from "./presentation.js";
import { R } from "./Review.strings.js";
import { Rows } from "./ReviewRows.js";
import type { ReviewScreenState } from "./useReviewScreen.js";

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
            {item.note && <Button onPress={() => state.setReader(item.note)}>{R.fullNote}</Button>}
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
                  <Button
                    key={action}
                    disabled={state.pending !== null || state.unknownItems.has(item.key)}
                    onPress={() => void state.choose(item, action)}
                  >
                    {label}
                  </Button>
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
