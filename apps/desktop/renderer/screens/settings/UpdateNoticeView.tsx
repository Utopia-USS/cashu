import { S } from "@cashu/i18n/core/chrome.strings";
import { C } from "@cashu/i18n/core/common.strings";
import type { UpdateNoticeState } from "./useUpdateNotice.js";

const safeLink = (raw: string | null) => {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

/** View-only packaged update stages and verified branch fallback. No updater is created here. */
export function UpdateNoticeView({ state }: { state: UpdateNoticeState }) {
  const status = state.status;
  if (status.availability !== "ready") return null;
  const app = status.app;
  const current = S.current(status.current);
  if (!app) {
    if (!status.branchAvailable || !status.latest || state.closedVersion === status.latest)
      return null;
    const link = safeLink(status.url);
    return (
      <Card
        title={S.newVersion(status.latest)}
        sub={current}
        onClose={() => state.onBranchClosed(status.latest ?? "")}
        closeTitle={C.close}
      >
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm bg-accent px-3 py-2 text-fg-inverse"
          >
            {S.seeChanges}
          </a>
        )}
      </Card>
    );
  }
  const version = app.version ?? "";
  switch (app.stage) {
    case "available":
      return (
        <Card
          title={S.newVersion(version)}
          sub={current}
          closeTitle={S.remindLater}
          onClose={() => {
            void state.onAction("dismiss");
          }}
        >
          <div className="flex gap-2">
            <button
              type="button"
              disabled={state.busy}
              onClick={() => {
                void state.onAction("install");
              }}
              className="rounded-sm bg-accent px-3 py-2 text-fg-inverse"
            >
              {S.install}
            </button>
            <button
              type="button"
              disabled={state.busy}
              onClick={() => {
                void state.onAction("skip");
              }}
              title={S.skipTitle}
              className="rounded-sm border border-border px-3 py-2"
            >
              {S.skip}
            </button>
          </div>
        </Card>
      );
    case "checking":
      return <Card title={S.checking} />;
    case "downloading": {
      const progress =
        app.progress === null ? null : Math.min(100, Math.max(0, Math.round(app.progress * 100)));
      return (
        <Card title={S.downloading(version)} sub={progress === null ? undefined : `${progress}%`}>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
            className="h-2 overflow-hidden rounded-sm bg-surface-sunken"
          >
            <div className="h-full bg-accent" style={{ width: `${progress ?? 0}%` }} />
          </div>
        </Card>
      );
    }
    case "installing":
      return <Card title={S.installing(version)} sub={S.relaunchSoon} />;
    case "up_to_date":
      return status.manualCheck ? (
        <Card
          title={S.upToDate}
          sub={status.current}
          onClose={() => {
            void state.onAction("dismiss");
          }}
          closeTitle={C.close}
        />
      ) : null;
    case "error":
      return status.manualCheck ? (
        <Card
          title={S.updateFailed}
          onClose={() => {
            void state.onAction("dismiss");
          }}
          closeTitle={C.close}
        />
      ) : null;
  }
}

function Card({
  title,
  sub,
  children,
  onClose,
  closeTitle,
}: {
  title: string;
  sub?: string;
  children?: React.ReactNode;
  onClose?: () => void;
  closeTitle?: string;
}) {
  return (
    <aside
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-4 z-50 flex max-w-sm gap-3 rounded-lg border border-border bg-surface-overlay p-4 shadow-lg"
    >
      <span aria-hidden="true">↑</span>
      <div className="grid gap-2">
        <strong>{title}</strong>
        {sub && <p className="text-sm text-fg-muted">{sub}</p>}
        {children}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={closeTitle ?? C.close}
          className="self-start rounded-sm border border-border px-2 py-1"
        >
          ×
        </button>
      )}
    </aside>
  );
}
