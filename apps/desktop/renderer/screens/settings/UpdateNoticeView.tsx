// The update card in the bottom-left corner (ab24ab6 core/UpdateNotice.tsx + update.css) on the native updater
// status: a found version waits for the owner (Aktualizuj / Pomiń / remind later), download and install stages,
// a check on demand reports here; elsewhere a newer branch version with a link to the changes. Pure view.
import { S } from "@cashu/i18n/core/chrome.strings";
import { CornerNotice } from "@cashu/ui";
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
    const latest = status.latest;
    if (!status.branchAvailable || !latest || state.closedVersion === latest) return null;
    const link = safeLink(status.url);
    return (
      <CornerNotice
        title={S.newVersion(latest)}
        sub={current}
        onClose={() => state.onBranchClosed(latest)}
        actions={link ? [{ label: S.seeChanges, href: link, primary: true }] : undefined}
      />
    );
  }
  const version = app.version ?? "";
  const act = (choice: "install" | "skip" | "dismiss") => () => {
    void state.onAction(choice);
  };
  switch (app.stage) {
    case "available":
      return (
        <CornerNotice
          title={S.newVersion(version)}
          sub={current}
          onClose={act("dismiss")}
          closeLabel={S.remindLater}
          actions={[
            { label: S.install, onPress: act("install"), primary: true, disabled: state.busy },
            { label: S.skip, onPress: act("skip"), title: S.skipTitle, disabled: state.busy },
          ]}
        />
      );
    case "downloading": {
      const pct =
        app.progress === null ? null : Math.min(100, Math.max(0, Math.round(app.progress * 100)));
      return (
        <CornerNotice
          title={S.downloading(version)}
          sub={pct === null ? "" : `${pct} %`}
          progress={pct}
        />
      );
    }
    case "installing":
      return <CornerNotice title={S.installing(version)} sub={S.relaunchSoon} />;
    case "checking":
      return <CornerNotice title={S.checking} />;
    case "up_to_date":
      return status.manualCheck ? (
        <CornerNotice title={S.upToDate} sub={status.current} onClose={act("dismiss")} />
      ) : null;
    case "error":
      return status.manualCheck ? (
        <CornerNotice
          title={S.updateFailed}
          sub={app.error ?? ""}
          tone="warning"
          onClose={act("dismiss")}
        />
      ) : null;
  }
}
