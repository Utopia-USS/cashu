// Sources of the statement import drawer's `Źródło` step (design/v3/first-steps section 4). The bank file and
// Open Banking are built in; `connectorSources` is the one extension point for connectors: each connector becomes
// one more radio, and its `Plik` step works like the bank file with `bank = connector:<id>`.
import type { ReactNode } from "react";
import type { ConnectorSourceItem } from "../../core/connectors";
import { StatusTag } from "../../core/ConnectorDrawer";
import { Tag } from "../../ui";

export interface ImportSource {
  /** "csv" | "open_banking" | "connector:<id>" (a connector's file goes through `Plik` with bank = this value). */
  value: string;
  title: ReactNode;
  desc?: ReactNode;
  tag?: ReactNode;
  disabled?: boolean;
  tooltip?: string;
}

/** Is this source a file the drawer uploads (`Plik` step)? The bank file and every connector. */
export const isFileSource = (v: string): boolean => v === "csv" || v.startsWith("connector:");

/** The bank file and Open Banking (`ebConfigured`: the Enable Banking key is in the keychain). */
export function builtinSources(ebConfigured: boolean): ImportSource[] {
  return [
    { value: "csv", title: "Plik CSV z banku", desc: "mBank, Bank Pekao, Erste: eksport historii z bankowości internetowej." },
    {
      value: "open_banking", title: "Open Banking", desc: "Enable Banking: logujesz się w banku, potem ↻ Synchronizuj co około dobę.",
      tag: ebConfigured ? undefined : <Tag tone="warn">nieskonfigurowany</Tag>,
    },
  ];
}

/** The connector radios (design/v3/connectors 5.1): one per budget file connector, approved ones selectable,
 * pending / changed / disabled ones shown disabled with their status; none at all = one disabled placeholder. */
export function connectorSources(items: readonly ConnectorSourceItem[] = []): ImportSource[] {
  if (!items.length) {
    return [{
      value: "connector", title: "Konektor", desc: "Własny importer innego banku; zgłasza go Claude Code, zatwierdzasz w Ustawieniach › Konektory.",
      disabled: true,
    }];
  }
  return items.map((c) => ({
    value: c.value, title: c.name, desc: c.desc,
    tag: c.disabled ? <StatusTag status={c.status === "approved" ? "pending" : c.status} /> : <Tag>konektor</Tag>,
    disabled: c.disabled, tooltip: c.disabled ? "Zatwierdź w Ustawieniach › Konektory" : undefined,
  }));
}
