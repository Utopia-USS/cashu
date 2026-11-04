import { useState } from "react";
import { C } from "./CandidatesRail.strings.js";
import { HomeRailRowView } from "./HomeRailView.js";

interface CandidateRailRow {
  readonly id: string;
  readonly tile: string;
  readonly name: string;
  readonly sentence: string;
  readonly watched: boolean;
  readonly busy: boolean;
  readonly criteria: readonly { readonly text: string; readonly met: boolean }[];
  readonly context: string | null;
  readonly onWatch: () => void;
  readonly onDismiss: () => void;
  readonly onOpen?: () => void;
}

export interface CandidatesRailViewProps {
  readonly privacy: boolean;
  readonly available: boolean;
  readonly freshCount: number;
  readonly totalOpen: number;
  /** Up to three open, unexpired candidates, with fresh candidates first. */
  readonly rows: readonly CandidateRailRow[];
  readonly notice: string | null;
  readonly onAll: () => void;
}

const action =
  "grid h-8 w-8 place-items-center rounded-sm hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

function ActionIcon({ kind }: { kind: "why" | "watch" | "dismiss" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "why" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2.5-2.5 4" />
          <path d="M12 17h.01" />
        </>
      ) : kind === "watch" ? (
        <>
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.5" />
        </>
      ) : (
        <path d="M5 5l14 14M19 5 5 19" />
      )}
    </svg>
  );
}

/** Compact candidate widget below Alerts. Eligibility and write reconciliation belong to its read/command hooks. */
export function CandidatesRailView({
  privacy,
  available,
  freshCount,
  totalOpen,
  rows,
  notice,
  onAll,
}: CandidatesRailViewProps) {
  const [why, setWhy] = useState<string | null>(null);
  return (
    <section
      className="grid content-start gap-3 rounded-lg border border-border bg-surface-raised p-4"
      aria-labelledby="home-rail-candidates"
      data-testid="native-candidates-rail"
    >
      <header className="flex items-center justify-between gap-3">
        <h2 id="home-rail-candidates" className="font-strong">
          {C.candidates}
        </h2>
        {totalOpen > 3 && (
          <button
            type="button"
            className="rounded-sm px-2 py-1 text-sm hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            onClick={onAll}
            disabled={privacy || !available}
          >
            {C.all(totalOpen)}
          </button>
        )}
      </header>
      {privacy ? (
        <p>{C.hidden}</p>
      ) : !available ? (
        <p>{C.unavailable}</p>
      ) : rows.length === 0 ? (
        <p>{C.empty}</p>
      ) : (
        <>
          {freshCount > 0 && <p className="text-sm font-strong">{C.fresh(freshCount)}</p>}
          <div>
            {rows.map((row) => (
              <div key={row.id} data-note={row.id}>
                <HomeRailRowView
                  tile={row.tile}
                  title={row.name}
                  text={row.sentence}
                  onOpen={row.onOpen}
                  right={
                    <>
                      <button
                        type="button"
                        className={action}
                        aria-label={C.whyName(row.name)}
                        title={C.why}
                        aria-expanded={why === row.id}
                        onClick={() => setWhy(why === row.id ? null : row.id)}
                      >
                        <ActionIcon kind="why" />
                      </button>
                      <button
                        type="button"
                        className={action}
                        aria-label={row.watched ? C.watchingName(row.name) : C.watchName(row.name)}
                        title={row.watched ? C.watching : C.watch}
                        disabled={row.busy || row.watched}
                        onClick={row.onWatch}
                      >
                        <ActionIcon kind="watch" />
                      </button>
                      <button
                        type="button"
                        className={action}
                        aria-label={C.dismissName(row.name)}
                        title={C.dismiss}
                        disabled={row.busy}
                        onClick={row.onDismiss}
                      >
                        <ActionIcon kind="dismiss" />
                      </button>
                    </>
                  }
                />
                {why === row.id && (
                  <div className="grid gap-1 pl-13 text-sm text-fg-muted">
                    {row.criteria.map((criterion) => (
                      <span key={`${criterion.met}-${criterion.text}`}>
                        {criterion.met ? "✓" : "·"} {criterion.text}
                      </span>
                    ))}
                    {row.context && <span>{row.context}</span>}
                    {row.criteria.length === 0 && !row.context && <span>{row.sentence}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {notice && !privacy && <p role="status">{notice}</p>}
    </section>
  );
}
