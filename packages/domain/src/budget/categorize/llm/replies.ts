/**
 * Parsing of the backends' replies (`local_llm.classify_*`, `llm._parse_batch_response`). A batch
 * either yields answers or fails as a whole with a value-free reason; nothing here throws on model
 * output.
 */

import { isRecord, parsePyJson } from "../../../pyJson.js";
import { PY_WS } from "../../../text.js";
import type { Answer, ClassifierFailure } from "./port.js";
import { OTHER, UNKNOWN } from "./prompts.js";

export type BatchResult<K> =
  | { readonly ok: true; readonly answers: ReadonlyMap<K, Answer> }
  | { readonly ok: false; readonly reason: ClassifierFailure };

const MALFORMED = { ok: false, reason: "malformed" } as const;
const FLOAT_TEXT =
  /^[+-]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const SPECIAL_FLOAT = /^[+-]?(?:inf|infinity|nan)$/i;
const EDGE_WS = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");

/** Python `float(x)` of a decoded JSON value; null where it raises `TypeError` / `ValueError`. */
function pyFloat(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return null;
  const s = value.replace(EDGE_WS, "");
  if (SPECIAL_FLOAT.test(s)) {
    if (/nan/i.test(s)) return Number.NaN;
    return s.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  return FLOAT_TEXT.test(s) ? Number(s.replaceAll("_", "")) : null;
}

/**
 * Python `max(0.0, min(1.0, x))`. Builtin min / max keep the first argument unless the other one is
 * smaller / larger, so NaN gives 1.0 and -0.0 gives 0.0 (`Math.min` / `Math.max` would differ).
 */
function clamp01(x: number): number {
  if (!(x < 1)) return 1;
  if (!(x > 0)) return 0;
  return x;
}

/** A value Python cannot hash (`in set` / `dict.get` raise `TypeError`, which fails the batch). */
const unhashable = (v: unknown): boolean => typeof v === "object" && v !== null;

/**
 * Python `for item in value` over a decoded JSON value where every item must be a dict (`.get`):
 * a list's items, a str's characters, a dict's keys; null where Python raises (`TypeError` /
 * `AttributeError`), so the batch fails.
 */
function pyDictItems(value: unknown): readonly Record<string, unknown>[] | null {
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? Array.from(value)
      : isRecord(value)
        ? Object.keys(value)
        : [null];
  return items.every(isRecord) ? items : null;
}

/** `json.loads(content).get("results", [])` iterated; null = the batch fails (FIX(Q11)). */
function results(content: unknown): readonly Record<string, unknown>[] | null {
  if (!isRecord(content)) return null; // FIX(Q11): Python raised AttributeError and aborted the run
  return pyDictItems("results" in content ? content.results : []);
}

/** Ollama's per-item category / confidence (`local_llm`: missing confidence 0.5, bad one 0.5). */
function ollamaAnswer(item: Record<string, unknown>, allowed: ReadonlySet<string>): Answer {
  const cat = item.category;
  const category = typeof cat === "string" && allowed.has(cat) ? cat : OTHER;
  const conf = "confidence" in item ? pyFloat(item.confidence) : 0.5;
  return { category, confidence: conf === null ? 0.5 : clamp01(conf) };
}

/**
 * `local_llm.classify_merchants` per batch: the reply `content` (a JSON string) -> merchant ->
 * answer. Unknown ids are ignored; a category outside the keys + `other` becomes `other`.
 */
export function parseOllamaMerchantReply(
  content: string,
  idToMerchant: ReadonlyMap<string, string>,
  categoryKeys: readonly string[],
): BatchResult<string> {
  let parsed: unknown;
  try {
    parsed = parsePyJson(content);
  } catch {
    return MALFORMED;
  }
  const items = results(parsed);
  if (items === null || items.some((r) => unhashable(r.category))) return MALFORMED;
  const allowed = new Set([...categoryKeys, OTHER]);
  const answers = new Map<string, Answer>();
  for (const r of items) {
    const merchant = typeof r.id === "string" ? idToMerchant.get(r.id) : undefined;
    if (!merchant) continue;
    answers.set(merchant, ollamaAnswer(r, allowed));
  }
  return { ok: true, answers };
}

/**
 * `local_llm.classify_transactions` per batch: item id -> answer. FIX(Q10, D-09.5b): only this
 * batch's ids are accepted (Python took any id, so a hallucinated `t<n>` could recategorize another
 * group). FIX(Q11, D-09.5c): a non-object reply or item fails the batch, the run continues.
 */
export function parseOllamaTxnReply(
  content: string,
  batchIds: readonly string[],
  categoryKeys: readonly string[],
): BatchResult<string> {
  let parsed: unknown;
  try {
    parsed = parsePyJson(content);
  } catch {
    return MALFORMED;
  }
  const items = results(parsed);
  if (items === null || items.some((r) => unhashable(r.category))) return MALFORMED;
  const allowed = new Set([...categoryKeys, OTHER]);
  const ids = new Set(batchIds);
  const answers = new Map<string, Answer>();
  for (const r of items) {
    if (typeof r.id !== "string" || !ids.has(r.id)) continue;
    answers.set(r.id, ollamaAnswer(r, allowed));
  }
  return { ok: true, answers };
}

/**
 * `llm._parse_batch_response`: the first `text` block of the Messages API response, parsed. Unknown
 * ids are skipped; `UNKNOWN` or a category outside the keys becomes `other`; a missing or bad
 * confidence is 0.0. Any exception Python raises fails the whole batch (`malformed`).
 */
export function parseAnthropicReply(
  data: unknown,
  idToMerchant: ReadonlyMap<string, string>,
  categoryKeys: readonly string[],
): BatchResult<string> {
  if (!isRecord(data)) return MALFORMED;
  const blocks: unknown = "content" in data ? data.content : [];
  const iterable = Array.isArray(blocks)
    ? blocks
    : typeof blocks === "string"
      ? Array.from(blocks)
      : isRecord(blocks)
        ? Object.keys(blocks)
        : null;
  if (iterable === null) return MALFORMED;
  let text: unknown = "";
  for (const block of iterable) {
    if (!isRecord(block)) return MALFORMED;
    if (block.type === "text") {
      text = "text" in block ? block.text : "";
      break;
    }
  }
  if (typeof text !== "string") return MALFORMED;
  let parsed: unknown;
  try {
    parsed = parsePyJson(text);
  } catch {
    return MALFORMED;
  }
  const items = results(parsed);
  if (items === null) return MALFORMED;
  const allowed = new Set([...categoryKeys, OTHER]);
  const answers = new Map<string, Answer>();
  for (const item of items) {
    if (unhashable(item.id)) return MALFORMED;
    const merchant = typeof item.id === "string" ? idToMerchant.get(item.id) : undefined;
    if (merchant === undefined) continue;
    const cat = item.category;
    if (unhashable(cat)) return MALFORMED;
    const category = cat === UNKNOWN || typeof cat !== "string" || !allowed.has(cat) ? OTHER : cat;
    const conf = pyFloat(item.confidence);
    answers.set(merchant, { category, confidence: conf === null ? 0 : clamp01(conf) });
  }
  return { ok: true, answers };
}
