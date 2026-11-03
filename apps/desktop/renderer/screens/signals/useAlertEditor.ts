import type { ReadySignals } from "@cashu/store/investments/signals-screen";
import { useForm, useStore } from "@tanstack/react-form";
import { useState } from "react";
import { type AlertRow, alertDraft, alertInput } from "./alertForm.js";
import { G } from "./Signals.strings.js";

export type AlertEditorProps = {
  data: ReadySignals;
  alert: AlertRow | null;
  busy: boolean;
  onSave(input: { alert: string | null; fields: Record<string, unknown> }): void;
  onClose(): void;
};
/** The alert editor's hook owns draft and canonical validation for one selected alert. */
export function useAlertEditor(props: AlertEditorProps) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: alertDraft(props.alert, props.data.catalog),
    onSubmit: ({ value }) => {
      const result = alertInput(value, props.alert, props.data.catalog, props.data.instruments);
      if (result.ok) props.onSave({ alert: props.alert?.gid ?? null, fields: result.fields });
      else setError(G.code(result.reason));
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const info = props.data.catalog.find((item) => item.kind === values.kind);
  return { ...props, form, values, error, info };
}
export type AlertEditorState = ReturnType<typeof useAlertEditor>;
