// Delete an alert with the restore undo (ab24ab6 v2/Alerts.tsx removeAlertWithUndo): the asset page's agent-alert X
// and the alerts manager. The toast's "Cofnij" restores it (same id, agent source and history; 15 minutes).
import { S } from "@cashu/i18n/investments/v2/Alerts.strings";
import { useToast } from "@cashu/ui";
import type { Alert } from "@cashu/ui-logic/investments/v2/types";
import { useInFlight } from "./legacy/inflight.js";
import { errorText } from "./legacy/outcome.js";
import { alertDeleteUndo, offerUndo } from "./legacy/undoFlow.js";
import { type LegacySignalsApi, useLegacySignalsApi } from "./useLegacySignalsApi.js";

/** False when the delete failed (its toast is shown). */
export async function removeAlertWithUndo(
  api: LegacySignalsApi,
  a: Alert,
  toast: ReturnType<typeof useToast>,
): Promise<boolean> {
  try {
    await api.deleteAlert(a.id);
  } catch (e) {
    toast(S.removeFailed(errorText(e)), 5000);
    return false;
  }
  offerUndo(
    toast,
    S.removed(a.title),
    alertDeleteUndo(() => api.restoreAlert(a.id)),
    S.removeWhat,
    () => {},
    10000,
  );
  return true;
}

/** `(alert) => void` for an AlertRow's remove button (one request at a time). */
export function useRemoveAlert() {
  const toast = useToast();
  const api = useLegacySignalsApi();
  const flight = useInFlight();
  return (a: Alert) => {
    void flight.run(() => removeAlertWithUndo(api, a, toast));
  };
}
