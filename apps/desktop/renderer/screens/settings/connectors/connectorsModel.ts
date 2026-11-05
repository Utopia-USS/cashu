// Pure helpers of Ustawienia › Konektory on the native connector snapshot (ab24ab6 core/connectors.ts parts the
// native data carries: status vocabulary, list order, labels, the binding form's parameters).
import { KIND, MODULE } from "@cashu/i18n/core/connectors.strings";
import type { SettingsScreenState } from "../useSettingsScreen.js";

type Snapshot = NonNullable<SettingsScreenState["connectorSnapshot"]>;
export type Connector = Snapshot["connectors"][number];
export type Binding = Snapshot["bindings"][number];
export type Account = Snapshot["accounts"][number];

const ORDER: Readonly<Record<string, number>> = {
  changed: 0,
  pending: 1,
  approved: 2,
  disabled: 3,
};
/** changed, pending, approved, disabled; then by name (Polish collation). */
export function sortConnectors<T extends { approval: string; name: string }>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (a, b) =>
      (ORDER[a.approval] ?? 9) - (ORDER[b.approval] ?? 9) || a.name.localeCompare(b.name, "pl"),
  );
}

export const moduleLabel = (module: string): string =>
  module in MODULE ? MODULE[module as keyof typeof MODULE] : module;
export const kindLabel = (kind: string): string =>
  kind in KIND ? KIND[kind as keyof typeof KIND] : kind;

/** `sha256 0123456789ab…` (old checksum line). */
export const shortSha = (sha: string): string => `sha256 ${sha.slice(0, 12)}…`;
