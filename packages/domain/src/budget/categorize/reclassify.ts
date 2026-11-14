/**
 * Full re-classification with the transaction classifier (`categorize/reclassify.py`): signature
 * grouping, the context text sent to the model, structural and owner exclusions, and the sign
 * guard. Pure planning and applying; the port call happens in between. Every Polish literal of the
 * context is matching data (prompt text), pinned by `contextLiterals` in the matching data.
 */

import type { IsoDate } from "../../dates.js";
import { type Decimal, format2, ZERO } from "../../decimal.js";
import { ibanKey } from "../../iban.js";
import { pyRegex } from "../../pyRegex.js";
import { isCombining, pyLen, pyStrip, pyStripChars, pyUpper } from "../../text.js";
import { stripTxDateSuffix } from "../ingestion/index.js";
import {
  type Categorization,
  type EngineContext,
  type EngineTxn,
  ownerDecision,
} from "./engine.js";
import {
  AUTO_CATEGORY_KEYS,
  categoryLabel,
  INCOME_KEYS,
  MANUAL_ONLY,
  STRUCTURAL_CATEGORIES,
} from "./taxonomy.js";

/** The Python sources of the signature regexes (`reclassify.py:42-46`, pinned by the matching data). */
export const RECLASSIFY_PATTERNS = {
  dates: "DATA TRANSAKCJI:.*$", // re.IGNORECASE
  card: "\\d{6}\\*+\\d{3,4}",
  amount: "\\d[\\d ]*[.,]\\d{2}\\s*(?:PLN|EUR|USD|NOK|HUF|GBP|CHF)?", // re.IGNORECASE
  longNum: "\\b[\\d/]{6,}\\b",
  ws: "\\s+",
} as const;

const CARD = pyRegex(RECLASSIFY_PATTERNS.card, "g");
// `iu` folds K/Kelvin and S/ſ like Python; no i-letter in the pattern.
const AMOUNT = pyRegex(`(?i)${RECLASSIFY_PATTERNS.amount}`, "g");
const LONG_NUM = pyRegex(RECLASSIFY_PATTERNS.longNum, "g");
const WS = pyRegex(RECLASSIFY_PATTERNS.ws, "g");

/**
 * The category keys the transaction classifier may answer (reclassify.py `allowed`): the automatic
 * keys without the structural ones. An `llm_full` claim outside them is refused (D-09.5a).
 */
export const RECLASSIFY_KEYS: readonly string[] = Object.freeze(
  AUTO_CATEGORY_KEYS.filter((k) => !STRUCTURAL_CATEGORIES.has(k)),
);

/** `reclassify.OWNER_SOURCES`: sources that record an owner decision. */
export const OWNER_SOURCES: ReadonlySet<string> = new Set(["manual", "manual_txn", "cash_leg"]);

export interface ReclassifyRow extends EngineTxn {
  readonly key: string;
  readonly bookingDate: IsoDate;
  readonly currency: string;
  readonly onCashAccount: boolean;
  /** The row's current (effective) category and source. */
  readonly category: string | null;
  readonly source: string | null;
}

type SignatureFields = Pick<EngineTxn, "counterpartyName" | "reference" | "description">;

/** `_strip_accents`: NFKD, combining marks dropped (`ł` stays: no decomposition). */
function stripAccents(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFKD")) if (!isCombining(ch.codePointAt(0) as number)) out += ch;
  return out;
}

/**
 * `txn_signature`: the key grouping rows with the same descriptive text. Dates, card masks,
 * amounts and long numbers are removed (Python Unicode semantics, Q15).
 */
export function txnSignature(t: SignatureFields): string {
  const raw = [t.counterpartyName ?? "", t.reference ?? "", t.description ?? ""].join(" | ");
  // `_DATES` is the same pattern as merchant_key's suffix (IGNORECASE folding pinned by S07).
  let s = stripTxDateSuffix(raw);
  s = s.replace(CARD, "");
  s = s.replace(AMOUNT, "");
  s = s.replace(LONG_NUM, "");
  s = pyStripChars(pyUpper(stripAccents(s).replace(WS, " ")), " |");
  return s || pyUpper(pyStrip(raw.replace(WS, " ")));
}

/** Python `min` / `max`: the first of equal values wins (`-0` vs `0` changes the text, Q14). */
function firstExtreme(
  values: readonly Decimal[],
  better: (a: Decimal, b: Decimal) => boolean,
): Decimal {
  let best = values[0] as Decimal;
  for (const v of values.slice(1)) if (better(v, best)) best = v;
  return best;
}

/** `txn_context`: the human-readable transaction text handed to the model (Polish data). */
export function txnContext(rep: ReclassifyRow, amounts: readonly Decimal[]): string {
  const lines: string[] = [];
  if (rep.counterpartyName) lines.push(`Odbiorca/nadawca: ${rep.counterpartyName}`);
  if (rep.reference) lines.push(`Tytuł: ${rep.reference}`);
  if (rep.description && rep.description !== rep.reference) lines.push(`Opis: ${rep.description}`);
  const lo = firstExtreme(amounts, (a, b) => a.lt(b));
  const hi = firstExtreme(amounts, (a, b) => a.gt(b));
  if (lo.eq(hi)) {
    const kind = lo.gt(ZERO) ? "wpływ" : "wydatek";
    lines.push(`Kwota: ${format2(lo)} ${rep.currency} (${kind})`);
  } else {
    const kind = lo.gte(ZERO) ? "wpływy" : hi.lte(ZERO) ? "wydatki" : "mieszane";
    lines.push(
      `Kwoty (${amounts.length}× wyst.): od ${format2(lo)} do ${format2(hi)} ${rep.currency} (${kind})`,
    );
  }
  if (lines.length === 1) lines.unshift("Odbiorca/nadawca: (brak danych)");
  return lines.join("\n");
}

/** `is_owner_decided`: the row carries the owner's own decision (by source or category). */
export function isOwnerDecided(row: {
  readonly category: string | null;
  readonly source: string | null;
}): boolean {
  return (
    (row.source !== null && OWNER_SOURCES.has(row.source)) ||
    (row.category !== null && MANUAL_ONLY.has(row.category))
  );
}

/** `_is_structural`: cash pool, internal transfer, structural category or an own counterparty. */
export function isStructural(row: ReclassifyRow, ownIbans: ReadonlySet<string>): boolean {
  if (row.onCashAccount) return true;
  if (row.isInternalTransfer || (row.category !== null && STRUCTURAL_CATEGORIES.has(row.category)))
    return true;
  const cp = row.counterpartyIban ? ibanKey(row.counterpartyIban) : "";
  return !!cp && ownIbans.has(cp);
}

export interface ReclassifyGroup {
  /** `t<i>`: the item id sent to the model. */
  readonly id: string;
  /** Row keys of the group, in input order. */
  readonly rows: readonly string[];
  readonly context: string;
}

export interface ReclassifyPlan {
  readonly targets: number;
  /** Rows the owner's configuration decides (derived, no event; for the stats). */
  readonly configured: readonly { readonly key: string; readonly result: Categorization }[];
  readonly groups: readonly ReclassifyGroup[];
  readonly allowedKeys: readonly string[];
  /** Polish labels of `allowedKeys`, key order (the prompt's category list). */
  readonly allowedLabels: ReadonlyMap<string, string>;
}

export interface ReclassifyOptions {
  readonly limit?: number;
  readonly dateFrom?: IsoDate;
  readonly dateTo?: IsoDate;
}

/**
 * `reclassify_all` up to the model call (reclassify.py:152-199): candidates (not structural, not
 * owner-decided, in the inclusive date range), the configured ones split off, the rest grouped by
 * signature in first-seen order of `rows` (Q13: the caller's deterministic order), `limit` groups.
 */
export function planReclassify(
  rows: readonly ReclassifyRow[],
  ctx: EngineContext,
  opts: ReclassifyOptions = {},
): ReclassifyPlan {
  const configured: { key: string; result: Categorization }[] = [];
  const groups = new Map<string, ReclassifyRow[]>();
  let targets = 0;
  for (const t of rows) {
    if (isStructural(t, ctx.ownIbans) || isOwnerDecided(t)) continue;
    if (opts.dateFrom !== undefined && t.bookingDate < opts.dateFrom) continue;
    if (opts.dateTo !== undefined && t.bookingDate > opts.dateTo) continue;
    const decided = ownerDecision(t, ctx);
    if (decided !== null) {
      configured.push({ key: t.key, result: decided });
      continue;
    }
    targets++;
    const sig = txnSignature(t);
    const g = groups.get(sig);
    if (g === undefined) groups.set(sig, [t]);
    else g.push(t);
  }
  let entries = [...groups.values()];
  if (opts.limit !== undefined) entries = entries.slice(0, Math.max(0, opts.limit));
  const planned = entries.map((txns, i) => {
    let rep = txns[0] as ReclassifyRow;
    let repLen = pyLen((rep.reference ?? "") + (rep.description ?? ""));
    for (const t of txns.slice(1)) {
      const len = pyLen((t.reference ?? "") + (t.description ?? ""));
      if (len > repLen) {
        rep = t;
        repLen = len;
      }
    }
    return {
      id: `t${i}`,
      rows: txns.map((t) => t.key),
      context: txnContext(
        rep,
        txns.map((t) => t.amount),
      ),
    };
  });
  const allowedKeys = [...RECLASSIFY_KEYS];
  return {
    targets,
    configured,
    groups: planned,
    allowedKeys,
    allowedLabels: new Map(allowedKeys.map((k) => [k, categoryLabel(k)])),
  };
}

/**
 * `_sign_correct`: the direction is ground truth (outflows are never income, inflows always
 * income_*), and a structural answer never leaks through.
 */
export function signCorrect(category: string, amount: Decimal): string {
  let cat = category;
  if (cat === "cash_withdrawal") cat = "cash";
  else if (cat === "transfer") cat = "other";
  if (amount.gt(ZERO) && !INCOME_KEYS.has(cat)) return "income_other";
  if (amount.lt(ZERO) && INCOME_KEYS.has(cat)) return "other";
  return cat;
}

/**
 * reclassify.py:218-236: an answered group gives each row an `llm_full` claim (sign-corrected);
 * an unanswered group's rows get no claim (`fallback`): Python writes the engine's result with no
 * recurring signal, which the next `categorize_all` overwrites, so under the D-24.1 recompute the
 * derived value is exact without an event.
 */
export function applyReclassify(
  plan: ReclassifyPlan,
  rowsByKey: ReadonlyMap<string, Pick<ReclassifyRow, "amount">>,
  answers: ReadonlyMap<string, { readonly category: string }>,
): { claims: { key: string; category: string }[]; fallback: string[] } {
  const claims: { key: string; category: string }[] = [];
  const fallback: string[] = [];
  for (const g of plan.groups) {
    const answer = answers.get(g.id);
    for (const key of g.rows) {
      const row = rowsByKey.get(key);
      if (answer === undefined || row === undefined) fallback.push(key);
      else claims.push({ key, category: signCorrect(answer.category, row.amount) });
    }
  }
  return { claims, fallback };
}
