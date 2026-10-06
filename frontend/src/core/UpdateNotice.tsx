// Update notice: a small card in the bottom-left corner when the configured GitHub branch carries a higher
// version than the running app (GET /api/system/update, core/updates.py). Shown on every launch; closing it
// only hides it until the next one. Errors and "up to date" render nothing.
import { useState } from "react";
import { useAsync } from "../hooks";
import { getUpdate } from "./api";
import "./update.css";

export function UpdateNotice() {
  const { data } = useAsync(getUpdate, []);
  const [closed, setClosed] = useState(false);
  if (closed || !data?.available || !data.latest) return null;
  return (
    <aside className="upd" role="status" aria-live="polite">
      <span className="upd-ico" aria-hidden>
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 12.5V3.5M4 7.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <div className="upd-body">
        <div className="upd-ttl">Nowa wersja {data.latest}</div>
        <div className="upd-sub">Masz {data.current}</div>
        {data.url && (
          <a className="btn primary upd-act" href={data.url} target="_blank" rel="noopener noreferrer">Zobacz zmiany</a>
        )}
      </div>
      <button className="upd-x" onClick={() => setClosed(true)} aria-label="Zamknij" title="Zamknij">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
    </aside>
  );
}
