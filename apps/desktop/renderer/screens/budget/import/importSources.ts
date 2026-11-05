// Sources of the statement import drawer's `Źródło` step (ab24ab6 modules/budget/importSources.tsx): the bank
// file and Open Banking are built in; connectors are one radio each (none read natively yet: the disabled
// placeholder, as the old drawer showed without connectors).
import { S } from "@cashu/i18n/budget/importSources.strings";

export interface ImportSource {
  /** "csv" | "open_banking" | "connector:<id>" | "connector" (the placeholder). */
  value: string;
  title: string;
  desc?: string;
  /** A warning tag after the title (`nieskonfigurowany`). */
  warn?: string;
  /** A plain tag after the title (`konektor`). */
  tag?: string;
  disabled?: boolean;
  tooltip?: string;
}

/** Is this source a file the drawer uploads (`Plik` step)? The bank file and every connector. */
export const isFileSource = (v: string): boolean => v === "csv" || v.startsWith("connector:");

/** The bank file and Open Banking (`ebConfigured`: the Enable Banking key is set up). */
export function builtinSources(ebConfigured: boolean): ImportSource[] {
  return [
    { value: "csv", title: S.csvTitle, desc: S.csvDesc },
    {
      value: "open_banking",
      title: "Open Banking",
      desc: S.obDesc,
      ...(ebConfigured ? {} : { warn: S.notConfigured }),
    },
  ];
}

/** One radio per budget file connector; none = one disabled placeholder. */
export function connectorSources(
  items: readonly { value: string; name: string; desc?: string; disabled: boolean }[] = [],
): ImportSource[] {
  if (!items.length)
    return [{ value: "connector", title: S.connector, desc: S.connectorDesc, disabled: true }];
  return items.map((c) => ({
    value: c.value,
    title: c.name,
    ...(c.desc ? { desc: c.desc } : {}),
    ...(c.disabled ? { warn: S.approveHint } : { tag: S.connectorTag }),
    disabled: c.disabled,
    ...(c.disabled ? { tooltip: S.approveHint } : {}),
  }));
}
