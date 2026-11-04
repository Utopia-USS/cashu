import { useProfile } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useEffect } from "react";
import { AlertEditorScreen } from "./AlertEditorScreen.js";
import { SignalsPageView } from "./SignalsView.js";
import { type SignalsScreenOptions, useSignalsScreen } from "./useSignalsScreen.js";

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

export function SignalsPageScreen(
  props: SignalsScreenOptions & {
    page: "alerts" | "watchlist" | "journal";
    initialNewAlert?: boolean;
  },
) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <BoundSignals
      key={`${vault}:${privacy}:${props.page}:${props.initialInstrument ?? ""}:${props.initialNewAlert ?? false}`}
      {...props}
    />
  );
}
function BoundSignals(
  props: SignalsScreenOptions & {
    page: "alerts" | "watchlist" | "journal";
    initialNewAlert?: boolean;
  },
) {
  const state = useSignalsScreen({ ...props, onExportCsv: downloadCsv });
  const { setEditingAlert } = state;
  useEffect(() => {
    if (props.initialNewAlert) setEditingAlert("new");
  }, [props.initialNewAlert, setEditingAlert]);
  const selected = state.data?.alerts.find((row) => row.gid === state.editingAlert) ?? null;
  const editor =
    state.editingAlert && state.data ? (
      <AlertEditorScreen
        key={state.editingAlert}
        data={state.data}
        alert={selected}
        busy={state.busy}
        onSave={(input) => void state.saveAlert(input)}
        onClose={() => state.setEditingAlert(null)}
      />
    ) : null;
  return <SignalsPageView state={state} page={props.page} editor={editor} />;
}
