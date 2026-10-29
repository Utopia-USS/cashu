// Update notice: a small card in the bottom-left corner (GET /api/system/update, core/updates.py).
// - cashU.app with an update feed (`app`, desktop/updater.py, Sparkle): this card is the updater's whole UI.
//   A found version waits for the owner: "Aktualizuj" downloads, verifies and installs it, then cashU restarts;
//   "Pomiń" never offers it again; closing reminds later. Checks on demand ("Sprawdź" in Settings, the app menu)
//   report here too. The app pushes a `cashu-update` event on every change; the poll is the fallback.
// - Elsewhere: the configured GitHub branch carries a higher version than the running app, with a link to the
//   changes; closing hides it until the next launch.
// Errors of the branch check and "up to date" without a check on demand render nothing.
import { type ReactNode, useEffect, useState } from "react";
import { usePoll } from "../hooks";
import { useToast } from "../ui";
import { type AppUpdateState, getUpdate, postUpdateAction, UPDATE_EVENT, type UpdateAction } from "./api";
import { errorText } from "./messages";
import "./update.css";
import { C } from "../common.strings.ts";
import { S } from "./chrome.strings.ts";

const POLL_MS = 10 * 60_000;
const BUSY_POLL_MS = 1_000; // while checking / downloading / installing, in case a push is missed
const DONE_MS = 4_000; // "up to date" closes itself
const BUSY: AppUpdateState["stage"][] = ["checking", "downloading", "installing"];

export function UpdateNotice() {
  const [busyPoll, setBusyPoll] = useState(false);
  const { data, reload } = usePoll(getUpdate, busyPoll ? BUSY_POLL_MS : POLL_MS, [], { keepPrevious: true });
  const [closed, setClosed] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const toast = useToast();
  const app = data?.app ?? null;

  useEffect(() => {
    window.addEventListener(UPDATE_EVENT, reload);
    return () => window.removeEventListener(UPDATE_EVENT, reload);
  }, [reload]);
  useEffect(() => setBusyPoll(!!app && BUSY.includes(app.stage)), [app?.stage]);
  useEffect(() => {
    if (app?.stage !== "up_to_date") return;
    const t = setTimeout(() => act("dismiss"), DONE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.stage]);

  function act(action: UpdateAction) {
    setSending(true);
    postUpdateAction(action)
      .catch((e: unknown) => toast(S.actionFailed(errorText(e))))
      .finally(() => { setSending(false); reload(); });
  }

  if (!data) return null;
  if (!app) {
    const version = data.available ? data.latest : null;
    if (!version || closed === version) return null;
    return (
      <Card title={S.newVersion(version)} sub={S.current(data.current)} onClose={() => setClosed(version)}>
        {data.url && <a className="btn primary upd-act" href={data.url} target="_blank" rel="noopener noreferrer">{S.seeChanges}</a>}
      </Card>
    );
  }

  const v = app.version ?? "";
  switch (app.stage) {
    case "available":
      return (
        <Card title={S.newVersion(v)} sub={S.current(data.current)} onClose={() => act("dismiss")} closeTitle={S.remindLater}>
          <div className="upd-acts">
            <button className="btn primary upd-act" disabled={sending} onClick={() => act("install")}>{S.install}</button>
            <button className="btn upd-act" disabled={sending} onClick={() => act("skip")} title={S.skipTitle}>{S.skip}</button>
          </div>
        </Card>
      );
    case "downloading": {
      const pct = app.progress == null ? null : Math.round(app.progress * 100);
      return (
        <Card title={S.downloading(v)} sub={pct == null ? "" : `${pct} %`}>
          <div className="upd-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
            <span style={{ width: `${pct ?? 0}%` }} />
          </div>
        </Card>
      );
    }
    case "installing":
      return <Card title={S.installing(v)} sub={S.relaunchSoon} />;
    case "checking":
      return <Card title={S.checking} />;
    case "up_to_date":
      return <Card title={S.upToDate} sub={data.current} onClose={() => act("dismiss")} />;
    case "error":
      return <Card title={S.updateFailed} sub={app.error ?? ""} onClose={() => act("dismiss")} tone="warn" />;
    default:
      return null;
  }
}

function Card({ title, sub, onClose, closeTitle = C.close, tone, children }: {
  title: string; sub?: string; onClose?: () => void; closeTitle?: string; tone?: "warn"; children?: ReactNode;
}) {
  return (
    <aside className={`upd ${tone === "warn" ? "warn" : ""}`} role="status" aria-live="polite">
      <span className="upd-ico" aria-hidden>
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 12.5V3.5M4 7.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <div className="upd-body">
        <div className="upd-ttl">{title}</div>
        {sub ? <div className="upd-sub">{sub}</div> : null}
        {children}
      </div>
      {onClose && (
        <button className="upd-x" onClick={onClose} aria-label={closeTitle} title={closeTitle}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      )}
    </aside>
  );
}
