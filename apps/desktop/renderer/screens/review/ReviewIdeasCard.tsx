import { D } from "@cashu/domain";
import { Amount, DateText } from "@cashu/ui";
import { R } from "./Review.strings.js";
import { Rows } from "./ReviewRows.js";
import type { ReviewScreenState } from "./useReviewScreen.js";

const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
export function ReviewIdeasCard({ state }: { state: ReviewScreenState }) {
  return (
    <Rows rows={state.ideas} rowKey={(row) => row.id} label={R.ideas}>
      {(note) => (
        <section>
          <h3 className="font-strong">{note.subject.name}</h3>
          <p>{note.subject.sym}</p>
          {note.entryType && (
            <p>
              {R.entryType}: {note.entryType}
            </p>
          )}
          <p className="whitespace-pre-wrap">{note.context}</p>
          <DateText value={state.dates.notes[note.id] ?? null} />
          {state.detail && (
            <>
              <h4>{note.title}</h4>
              <p className="whitespace-pre-wrap">{note.summary}</p>
              <p>
                {R.criteria}: <Amount value={D(String(note.criteria.met))} fractionDigits={0} /> /{" "}
                <Amount value={D(String(note.criteria.total))} fractionDigits={0} />
              </p>
              <ul>
                {note.criteria.items.map((criterion) => (
                  <li key={criterion.label}>
                    {criterion.met ? R.met : R.notMet}: {criterion.label}
                  </li>
                ))}
              </ul>
              <ul>
                {note.sourceLinks.map((source) => (
                  <li key={source.url}>
                    <a
                      className="text-accent underline"
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.label}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => state.setReader(note.id)}>
              {R.fullNote}
            </button>
            {state.candidateChoices[note.id] ? (
              <button
                type="button"
                className={button}
                disabled={state.pending !== null}
                onClick={() => void state.candidate(note.id, "undo")}
              >
                {R.undoCandidate}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={button}
                  disabled={state.pending !== null}
                  onClick={() => void state.candidate(note.id, "watch")}
                >
                  {R.watch}
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={state.pending !== null}
                  onClick={() => void state.candidate(note.id, "dismiss")}
                >
                  {R.dismiss}
                </button>
              </>
            )}
          </div>
        </section>
      )}
    </Rows>
  );
}
