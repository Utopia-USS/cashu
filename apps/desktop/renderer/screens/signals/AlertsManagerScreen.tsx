// The mountable ported alerts manager page (ab24ab6 v2/Alerts.tsx AlertsManager, the Home's `alerts` sub-route):
// the page and its form, remounted per edited alert (old `key={editing:formKey}`).
import { AlertFormView, AlertsManagerView } from "./AlertsManagerView.js";
import { choiceText } from "./alertsModel.js";
import { type AlertFormInput, useAlertForm } from "./useAlertForm.js";
import { type AlertsManagerInput, alertFormProps, useAlertsManager } from "./useAlertsManager.js";

export type { AlertsManagerInput };

function AlertForm(props: AlertFormInput) {
  const st = useAlertForm(props);
  return (
    <AlertFormView
      {...alertFormProps(st, {
        buckets: props.buckets,
        instruments: props.instruments,
        instrumentList: props.instruments.map(choiceText),
        onCancel: props.onCancel,
      })}
    />
  );
}

export function AlertsManagerScreen(props: AlertsManagerInput) {
  const s = useAlertsManager(props);
  const { key, ...form } = s.form;
  return <AlertsManagerView {...s.view} form={<AlertForm key={key} {...form} />} />;
}
