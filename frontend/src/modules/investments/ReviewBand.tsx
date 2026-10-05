// Weekly review band between the KPIs and the grid: 3-step stepper (Co się zmieniło / Sygnały /
// Zamknij przegląd), the change list since the last review, a note and the one primary button.
import { Fragment } from "react";
import { Tag } from "../../ui";
import type { AccountRow, ReviewDigest } from "./api";
import { dm, WEEKDAYS } from "./labels";
import { type ChangeRow, changeRows, resolvedText, undecidedHint } from "./logic";

export function ReviewBand({ digest, accounts, step, onStep, note, onNote, decided, total, onDone, onJump, busy }: {
  digest: ReviewDigest;
  accounts: AccountRow[];
  step: number;
  onStep: (s: number) => void;
  note: string;
  onNote: (v: string) => void;
  decided: number;
  total: number;
  onDone: () => void;
  onJump: (key: ChangeRow["key"]) => void;
  busy: boolean;
}) {
  const rows = changeRows(digest, accounts);
  const last = digest.last_review;
  const minutes = typeof last?.stats?.minutes === "number" ? `, ${last.stats.minutes} min` : "";
  const weekday = WEEKDAYS[digest.digest_weekday] ?? digest.digest_weekday;
  const steps = ["Co się zmieniło", `Sygnały (${total})`, "Zamknij przegląd"];
  const undecided = total - decided;
  return (
    <section className="card review" aria-label="Przegląd tygodnia" id="inv-review">
      <div className="controls" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Przegląd tygodnia · {dm(digest.since)} - {dm(digest.as_of)}</h2>
        <Tag tone="info">{weekday} · {resolvedText(decided, total)}</Tag>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {last ? `poprzedni przegląd: ${dm(last.done_at)}${minutes}` : "pierwszy przegląd · zmiany z ostatnich 7 dni"}
        </span>
      </div>
      <ol className="steps" aria-label="Kroki przeglądu">
        {steps.map((label, k) => (
          <Fragment key={label}>
            {k > 0 && <li className="ln" aria-hidden />}
            <li>
              <button className={`st ${k < step ? "done" : k === step ? "on" : ""}`} aria-current={k === step ? "step" : undefined} onClick={() => onStep(k)}>
                <b>{k < step ? "✓" : k + 1}</b> {label}
              </button>
            </li>
          </Fragment>
        ))}
      </ol>
      <div className="body">
        <ul className="changes">
          {rows.map((r) => (
            <li key={r.key}>
              <span className="k"><button className="lnk" onClick={() => onJump(r.key)} title="Pokaż w przestrzeni roboczej">{r.label}</button></span>
              <span className="v"><b className={r.tone ?? ""}>{r.main}</b>{r.sub && <span className="sub"> · {r.sub}</span>}</span>
            </li>
          ))}
        </ul>
        <div>
          <label className="muted" style={{ fontSize: 12, marginBottom: 4, display: "block" }} htmlFor="inv-review-note">Notatka z przeglądu (opcjonalnie)</label>
          <textarea id="inv-review-note" rows={3} placeholder="Np. co obserwować w przyszłym tygodniu" value={note} onChange={(e) => onNote(e.target.value)} />
          {step === 1 && (
            <div className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>{decided} z {total} rozstrzygnięte · sygnały są w kolumnie „Do decyzji".</div>
          )}
          <div className="controls" style={{ margin: "10px 0 0" }}>
            <button className="btn primary" onClick={onDone} disabled={busy} id="inv-review-done">Oznacz przegląd jako zrobiony</button>
          </div>
          {undecided > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{undecidedHint(undecided)}</div>}
        </div>
      </div>
    </section>
  );
}
