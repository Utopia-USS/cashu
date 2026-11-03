import { AlertEditorView } from "./AlertEditorView.js";
import { type AlertEditorProps, useAlertEditor } from "./useAlertEditor.js";

export function AlertEditorScreen(props: AlertEditorProps) {
  return <AlertEditorView state={useAlertEditor(props)} />;
}
