/**
 * Assets: manually valued positions (property, ...) and depreciating vehicles
 * (`modules/assets/service.py`), as pure rules over the profile's rows.
 *
 * Python writes through the session; here the store commands write events and call these for the
 * decisions (which accounts the module owns, what a note looks like when stored). Removing and
 * restoring a position (`removed_at`) and parking a removed position's name key are core account
 * operations (`core.accounts`); net worth leaves a removed account out now and in the history.
 */

import { pyLen, pySplit } from "../text.js";

/** `MANUAL_PREFIXES`: external ids of the accounts this module creates (manual positions, vehicles). */
export const MANUAL_PREFIXES: readonly string[] = Object.freeze(["manual:", "vehicle:"]);

/** `models.NOTE_MAX`: the longest note, in characters (code points). */
export const NOTE_MAX = 500;

/** The institution id of manually created accounts (`core.institutions.MANUAL`). */
const MANUAL_BANK = "manual";

/** `AssetError`: invalid manual position input (message safe to show). */
export interface AssetRefusal {
  readonly ok: false;
  readonly reason: "note_too_long";
  readonly message: string;
}

export type NoteResult = { readonly ok: true; readonly note: string | null } | AssetRefusal;

/**
 * `clean_note`: a note as stored. Whitespace runs (newlines too) fold to one space and the ends are
 * trimmed, blank becomes null; longer than `NOTE_MAX` characters is refused, never cut.
 */
export function cleanNote(note: string | null): NoteResult {
  if (note === null) return { ok: true, note: null };
  const text = pySplit(note).join(" ");
  if (!text) return { ok: true, note: null };
  if (pyLen(text) > NOTE_MAX) {
    return {
      ok: false,
      reason: "note_too_long",
      message: `note is too long (max ${NOTE_MAX} characters)`,
    };
  }
  return { ok: true, note: text };
}

/** `is_module_account`: a manual position or vehicle this module created. */
export function isModuleAccount(account: {
  readonly bank: string;
  readonly externalId: string | null;
}): boolean {
  const ext = account.externalId ?? "";
  return account.bank === MANUAL_BANK && MANUAL_PREFIXES.some((p) => ext.startsWith(p));
}

/** A vehicle position (`api._is_vehicle`): its external id starts with `vehicle:`. */
export function isVehicle(account: { readonly externalId: string | null }): boolean {
  return (account.externalId ?? "").startsWith("vehicle:");
}

/** A stored note of a position (`models.AssetDetails`). */
export interface AssetNote {
  readonly accountId: string;
  readonly note: string | null;
}

/** `notes`: the non-empty notes of the given accounts, by account id. */
export function notesOf(
  details: readonly AssetNote[],
  accountIds: readonly string[],
): Map<string, string> {
  const wanted = new Set(accountIds);
  const out = new Map<string, string>();
  for (const d of details) if (wanted.has(d.accountId) && d.note) out.set(d.accountId, d.note);
  return out;
}

/** `manual:<name>` / `vehicle:<name>`: the name key of a new manual position or vehicle. */
export function positionKey(kind: "manual" | "vehicle", name: string): string {
  return `${kind}:${name}`;
}
