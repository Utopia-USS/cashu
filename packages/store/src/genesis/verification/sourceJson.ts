import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ALERT_KEY_RE, idFieldTable, isJsonObject, KEY_PART_RE, rowIdOf } from "../idFields.js";
import { json, type OutValue } from "./canonical.js";

export class SourceJsonError extends Error {
  constructor() {
    super("source_json_mismatch");
    this.name = "SourceJsonError";
  }
}

type IdMap = ReadonlyMap<string, string>;
export interface SealedSourceFiles {
  read(relative: string): Uint8Array | undefined;
}

const STAGED_NAME = /^([0-9a-f]{64})(?:-[0-9A-Za-z]+)?\.([A-Za-z0-9]{1,10})$/;
function stagedBlob(
  value: unknown,
  files?: SealedSourceFiles,
): { sha256: string; ext: string } | null {
  if (value === null) return null;
  if (typeof value !== "string" || !files || value.startsWith("/") || value.includes("\\")) {
    throw new SourceJsonError();
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new SourceJsonError();
  }
  const match = STAGED_NAME.exec(parts.at(-1) ?? "");
  if (!match) throw new SourceJsonError();
  const bytes = files.read(value);
  if (!bytes || bytesToHex(sha256(bytes)) !== match[1]) throw new SourceJsonError();
  return { sha256: match[1], ext: (match[2] ?? "").toLowerCase() };
}

function gid(ids: IdMap, table: string, value: unknown): string {
  const id = rowIdOf(value);
  if (id === undefined) throw new SourceJsonError();
  const found = ids.get(`${table}\0${id}`);
  if (!found) throw new SourceJsonError();
  return found;
}

function scalar(ids: IdMap, table: string, value: unknown): unknown {
  return value === null || value === undefined ? null : gid(ids, table, value);
}

function list(ids: IdMap, table: string, value: unknown): unknown {
  if (!Array.isArray(value)) throw new SourceJsonError();
  return value.map((entry) => {
    const id = rowIdOf(entry);
    return id === undefined ? entry : gid(ids, table, id);
  });
}

/** Source numeric key parts become the exact mapped gids that the replay projector reads back. */
export function sourceRuleKey(value: unknown, ids: IdMap, wholeAlertOnly: boolean): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new SourceJsonError();
  const alert = ALERT_KEY_RE.exec(value);
  if (alert) return `alert:${gid(ids, "alerts", alert[1])}`;
  if (wholeAlertOnly) return value;
  return value
    .split("|")
    .map((part) => {
      const match = KEY_PART_RE.exec(part);
      if (!match) return part;
      return `${match[1]}:${gid(ids, match[1] === "i" ? "inv_instruments" : "accounts", match[2])}`;
    })
    .join("|");
}

function rewrite(
  table: string,
  column: string,
  value: unknown,
  ids: IdMap,
  files?: SealedSourceFiles,
): unknown {
  if (!isJsonObject(value)) return value;
  const out: Record<string, unknown> = { ...value };
  const map = (key: string, target: string) => {
    if (key in out) out[key] = scalar(ids, target, out[key]);
  };
  const mapList = (key: string, target: string) => {
    if (key in out) out[key] = list(ids, target, out[key]);
  };
  switch (`${table}.${column}`) {
    case "inv_signals.payload":
      map("instrument_id", "inv_instruments");
      map("alert_id", "alerts");
      map("note_id", "research_notes");
      mapList("note_ids", "research_notes");
      if (Array.isArray(out.accounts)) mapList("accounts", "accounts");
      break;
    case "inv_rule_runs.report":
      mapList("new", "inv_signals");
      mapList("escalated", "inv_signals");
      break;
    case "research_notes.details":
      if ("watchlist_item_id" in out) {
        const id = rowIdOf(out.watchlist_item_id);
        out.watchlist_item_id =
          id === undefined ? out.watchlist_item_id : (ids.get(`watchlist_items\0${id}`) ?? null);
      }
      map("thesis_id", "inv_theses");
      map("previous_instrument_id", "inv_instruments");
      break;
    case "research_runs.scope":
      mapList("instrument_ids", "inv_instruments");
      mapList("covered_instrument_ids", "inv_instruments");
      break;
    case "transactions.raw":
      map("cash_leg_of", "transactions");
      break;
    case "proposals.payload":
      if ("binding_id" in out) throw new SourceJsonError();
      if ("account_id" in out) {
        out.account = scalar(ids, "accounts", out.account_id);
        delete out.account_id;
      }
      if ("staged" in out) {
        out.blob = stagedBlob(out.staged, files);
        delete out.staged;
      }
      break;
  }
  return out;
}

function guard(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) guard(entry);
    return;
  }
  if (!isJsonObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (idFieldTable(key)) {
      const values = Array.isArray(child) ? child : [child];
      if (values.some((entry) => rowIdOf(entry) !== undefined)) throw new SourceJsonError();
    }
    guard(child);
  }
}

/** Re-read and normalize source JSON independently of the event payload. */
export function projectSourceJson(
  table: string,
  column: string,
  raw: unknown,
  ids: IdMap,
  files?: SealedSourceFiles,
): OutValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new SourceJsonError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SourceJsonError();
  }
  const normalized = rewrite(table, column, parsed, ids, files);
  guard(normalized);
  return json(normalized, () => undefined);
}
