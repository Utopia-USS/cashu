import { useProfile } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useEffect } from "react";
import { AlertEditorScreen } from "./AlertEditorScreen.js";
import { AlertsPageView } from "./AlertsPageView.js";
import { JournalPageView } from "./JournalPageView.js";
import { SignalsDialogView, SignalsPageView } from "./SignalsView.js";
import {
  type SignalsPageKind,
  type SignalsScreenOptions,
  useSignalsScreen,
} from "./useSignalsScreen.js";
import { WatchlistPageView } from "./WatchlistPageView.js";

function downloadCsv(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

type Props = SignalsScreenOptions & { page: SignalsPageKind; initialNewAlert?: boolean };

export function SignalsPageScreen(props: Props) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <BoundSignals
      key={`${vault}:${privacy}:${props.page}:${props.initialInstrument ?? ""}:${props.initialNewAlert ?? false}`}
      {...props}
    />
  );
}
function BoundSignals(props: Props) {
  const state = useSignalsScreen({ ...props, onExportCsv: downloadCsv });
  const { alerts, data } = state;
  const { onEdit } = alerts;
  useEffect(() => {
    if (props.initialNewAlert) onEdit("new");
  }, [props.initialNewAlert, onEdit]);
  const editor =
    alerts.editing && data ? (
      <AlertEditorScreen
        key={alerts.editing}
        data={data}
        alert={alerts.editingRow}
        busy={alerts.busy}
        onSave={(input) => void alerts.onSave(input)}
        onClose={() => onEdit(null)}
      />
    ) : null;
  return (
    <SignalsPageView
      page={props.page}
      available={data !== null}
      privacy={state.privacy}
      feedback={state.feedback}
      onBack={state.onBack}
      onUndoLast={state.onUndoLast}
      dialogs={<SignalsDialogView state={state} />}
    >
      {props.page === "alerts" ? (
        <AlertsPageView {...alerts} editor={editor} />
      ) : props.page === "watchlist" ? (
        <WatchlistPageView {...state.watchlist} />
      ) : (
        <JournalPageView {...state.journal} />
      )}
    </SignalsPageView>
  );
}
