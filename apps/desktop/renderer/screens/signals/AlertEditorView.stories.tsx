import { UiEnvProvider } from "@cashu/ui";
import { AlertEditorView } from "./AlertEditorView.js";
import { G } from "./Signals.strings.js";
import { signalsStorySnapshot } from "./storyState.js";
import { useAlertEditor } from "./useAlertEditor.js";

function Story({ edit = false, bucket = false }: { edit?: boolean; bucket?: boolean }) {
  const data = signalsStorySnapshot();
  const original = data.alerts[0];
  const alert =
    edit && original
      ? bucket
        ? {
            ...original,
            scope: "bucket",
            kind: "weight_above",
            params: { threshold: 0.3, bucket: "equity" },
            instrument: null,
            unit: "ratio" as const,
          }
        : original
      : null;
  const state = useAlertEditor({ data, alert, busy: false, onSave() {}, onClose() {} });
  return <AlertEditorView state={state} />;
}
export default {
  title: "Desktop/Signals/Alert editor",
  component: AlertEditorView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const NewPrice = { render: () => <Story /> };
export const EditTriggered = { render: () => <Story edit /> };
export const BucketWithCurrentFile = { render: () => <Story edit bucket /> };
export const Polish = {
  render: () => (
    <UiEnvProvider locale="pl-PL" privacy={false}>
      <Story edit />
    </UiEnvProvider>
  ),
};
export const PrivacyGate = {
  render: () => (
    <UiEnvProvider locale="en-US" privacy>
      <p>{G.privacy}</p>
    </UiEnvProvider>
  ),
};
