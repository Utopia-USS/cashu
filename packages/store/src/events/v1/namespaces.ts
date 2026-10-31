// UUIDv5 namespaces of deterministic gids (spec: gid.md section 3). Never rename or reuse a row;
// `namespaces.test.ts` recomputes each one from ROOT_NAMESPACE.

export const ROOT_NAMESPACE = "6f1c2a4e-9b3d-4c57-8e21-5a0d7f3b9c64";
/** NS[table] = uuidv5(ROOT_NAMESPACE, NAMESPACE_NAME_PREFIX + table). */
export const NAMESPACE_NAME_PREFIX = "cashu.gid.v1/";
/** Separator between the parts of a DET canonical input (U+001F). */
export const UNIT_SEPARATOR = "\u001f";

export const GID_NAMESPACES = {
  profile_modules: "ae8339c1-283e-5550-84fa-274e723dd162",
  accounts: "5e032984-5b89-5761-bbbc-f53689111b44",
  balances: "1c4a87c8-065d-550a-95ae-3970b6c12576",
  transactions: "2ac77d85-bd6b-5882-a51b-1da9990aa103",
  category_rules: "c3f19568-8eaf-53dc-a19b-8688fa73633a",
  loans: "c8f3125f-7d82-5112-9c82-9235f2176ee4",
  depreciations: "bf2fa9d6-93a6-5b45-a307-5b0f1f6564c5",
  asset_details: "5f94e262-12b0-591e-a93a-8979cbb1c782",
  budget_settings: "e73dca20-09fc-5f75-ae5f-d6747e0500f9",
  inv_account_settings: "2a3c7835-76ab-522f-b08f-9841695358e9",
  inv_transactions: "712ba648-fe9e-5e86-817c-483ed84b1ad6",
  inv_position_snapshots: "6ae75ae0-0a5a-56ed-b125-bda1aa32e768",
  inv_instrument_renames: "e9c83675-d928-5a25-b47c-bab14bce9c31",
  inv_manual_valuations: "a831c985-29d4-525e-83da-0c52879590cd",
  inv_instruments: "5f9b3de7-fec7-51e5-bbb3-ab9433f84320",
  inv_instrument_aliases: "5282adad-b002-593a-ba08-1d3a514b1d0b",
  inv_profile_instruments: "5b2e0283-11b1-5551-a874-ad4806a1b5e1",
  inv_topic_theses: "c7403439-dbbf-5dfe-9f55-b7d2f323bc0a",
  watchlist_items: "d4505731-2d11-5325-a79a-a315935900bb",
  inv_signals: "f24f120c-f299-59b7-959e-4a262e046665",
  connector_bindings: "8b227d76-c7a5-5b99-bad8-d30c4d4337f8",
  /** Genesis gids of ULID tables: uuidv5(NS, [vault, table, localId]) (gid.md section 7). */
  genesis: "91808c46-334e-558b-9528-dfb40bce3a13",
} as const;

export type GidNamespace = keyof typeof GID_NAMESPACES;

/**
 * The canonical DET input string (gid.md section 3): the vault gid first, then the parts, joined by
 * U+001F. Throws on a part containing the separator (a writer bug, never real data).
 */
export function detInput(vault: string, parts: readonly string[]): string {
  for (const part of [vault, ...parts]) {
    if (part.includes(UNIT_SEPARATOR)) {
      throw new RangeError("a DET input part contains U+001F");
    }
  }
  return [vault, ...parts].join(UNIT_SEPARATOR);
}
