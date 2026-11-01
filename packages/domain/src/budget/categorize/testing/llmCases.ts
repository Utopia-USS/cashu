/** Checks of the LLM vectors (`budget-categorize-llm`, reclassify scenarios), tests only. */
import { looksLikePerson } from "../../../core/index.js";
import type { Mismatches } from "../../../testing/vectors.js";
import { categorizeAll } from "../effective.js";
import { categorize, txnMerchantKey } from "../engine.js";
import type { Answer } from "../llm/port.js";
import { ANTHROPIC_MERCHANT_PREFIX } from "../llm/prompts.js";
import {
  type BatchResult,
  parseAnthropicReply,
  parseOllamaMerchantReply,
  parseOllamaTxnReply,
} from "../llm/replies.js";
import {
  anthropicMerchantBatches,
  ollamaMerchantBatches,
  ollamaTxnBatches,
} from "../llm/requests.js";
import { unknownMerchants } from "../llmPass.js";
import { applyReclassify, planReclassify, type ReclassifyRow } from "../reclassify.js";
import { type MerchantRule, ruleUpsert } from "../rules.js";
import { AUTO_CATEGORY_KEYS } from "../taxonomy.js";
import {
  categorizeRow,
  inQueryOrder,
  NOT_SUBSCRIPTION,
  type ScenarioContext,
  type ScenarioRow,
  scenarioContext,
} from "./scenarios.js";
import { loadMatchingData } from "./vectors.js";

type Body = Record<string, unknown>;
type Request = [string, Body];
type Reply = ["ok", unknown] | ["status", number];

const SHARED = loadMatchingData().data.sharedBodies;
const tok = (v: unknown): unknown => (typeof v === "string" && v in SHARED ? SHARED[v] : v);

/** A recorded body with the shared prompt / schema tokens expanded back. */
function expandBody(body: Body): Body {
  if ("max_tokens" in body) {
    const oc = body.output_config as { format: Record<string, unknown> };
    return {
      ...body,
      system: tok(body.system),
      output_config: { format: { ...oc.format, schema: tok(oc.format.schema) } },
    };
  }
  const messages = (body.messages as Body[]).map((m, i) =>
    i === 0 ? { ...m, content: tok(m.content) } : m,
  );
  return { ...body, format: tok(body.format), messages };
}

/** The `[{id, merchant}]` list of an Anthropic request (Python's own ids). */
function anthropicIds(body: Body): Map<string, string> {
  const content = (body.messages as { content: string }[])[0]?.content ?? "";
  const items = JSON.parse(content.slice(ANTHROPIC_MERCHANT_PREFIX.length)) as {
    id: string;
    merchant: string;
  }[];
  return new Map(items.map((x) => [x.id, x.merchant]));
}

/** The merchants Python asked about, in request order. */
function requestedMerchants(backend: string, requests: readonly Request[]): string[] {
  return requests.flatMap(([, body]) => {
    if (backend === "anthropic") return [...anthropicIds(body).values()];
    const user = (body.messages as { content: string }[])[1]?.content ?? "";
    return user
      .slice("Classify:\n".length)
      .split("\n")
      .map((ln) => ln.slice(ln.indexOf(": ") + 2));
  });
}

function parseReply(
  backend: string,
  reply: Reply,
  ids: ReadonlyMap<string, string>,
  keys: readonly string[],
): BatchResult<string> {
  if (reply[0] === "status") return { ok: false, reason: "unreachable" };
  if (backend === "anthropic") return parseAnthropicReply(reply[1], ids, keys);
  return parseOllamaMerchantReply(reply[1] as string, ids, keys);
}

export interface LlmCounts {
  merchantCases: number;
  bodiesCompared: number;
  personCases: number;
  q11Aborts: number;
  passCases: number;
  rulesCompared: number;
  q9Answers: number;
  cashUnknown: number;
}

export const newCounts = (): LlmCounts => ({
  merchantCases: 0,
  bodiesCompared: 0,
  personCases: 0,
  q11Aborts: 0,
  passCases: 0,
  rulesCompared: 0,
  q9Answers: 0,
  cashUnknown: 0,
});

/** Batches of one backend, the ids each carries and the bodies (anthropic: malformed batches dropped). */
function tsBatches(backend: string, merchants: readonly string[], keys: readonly string[]) {
  if (backend === "ollama") return ollamaMerchantBatches(merchants, keys);
  return anthropicMerchantBatches(merchants, keys).flatMap((b) => ("ids" in b ? [b] : []));
}

/** Merged answers of every batch with Python's ids; `malformed` counts failed batches. */
function answersOf(
  backend: string,
  requests: readonly Request[],
  replies: readonly Reply[],
  keys: readonly string[],
  ollamaIds: readonly ReadonlyMap<string, string>[],
) {
  const answers = new Map<string, Answer>();
  let malformed = 0;
  requests.forEach(([, body], i) => {
    const ids = backend === "anthropic" ? anthropicIds(body) : (ollamaIds[i] ?? new Map());
    const res = parseReply(backend, replies[i] as Reply, ids, keys);
    if (!res.ok) {
      if (res.reason === "malformed") malformed++;
      return;
    }
    for (const [m, a] of res.answers) answers.set(m, a);
  });
  return { answers, malformed };
}

export type MerchantCase = [
  "merchants",
  number,
  string,
  string[],
  string[],
  Request[],
  Reply[],
  Record<string, [string, number]> | { error: string },
  Record<string, boolean>,
];

/** The backends on raw merchant lists: request bodies, reply parsing, the person guard (Q12). */
export function checkMerchantCases(
  cases: readonly MerchantCase[],
  m: Mismatches,
  c: LlmCounts,
): void {
  for (const [, n, backend, merchants, keys, requests, replies, result, personLike] of cases) {
    c.merchantCases++;
    for (const [mk, isPerson] of Object.entries(personLike))
      m.check(`#${n} person ${mk}`, looksLikePerson(mk), isPerson);
    const hasPerson = Object.values(personLike).some(Boolean);
    const batches = tsBatches(backend, merchants, keys);
    if (backend === "anthropic" && hasPerson) {
      c.personCases++;
      // FIX(Q12): no person-like merchant in any cloud batch.
      for (const b of batches)
        for (const mk of b.ids.values()) m.check(`#${n} person sent`, looksLikePerson(mk), false);
    } else {
      // An aborted Python call (Q11) sent only the batches before the failing one.
      const sent = "error" in result ? batches.slice(0, requests.length) : batches;
      c.bodiesCompared += requests.length;
      m.check(
        `#${n} bodies`,
        sent.map((b) => b.body),
        requests.map(([, body]) => expandBody(body)),
      );
    }
    const { answers, malformed } = answersOf(
      backend,
      requests,
      replies,
      keys,
      batches.map((b) => b.ids),
    );
    if ("error" in result) {
      // FIX(Q11): Python aborted the whole call on a non-object reply; TS fails that batch only.
      c.q11Aborts++;
      m.check(`#${n} malformed batch`, malformed > 0, true);
      continue;
    }
    const got = Object.fromEntries([...answers].map(([k, a]) => [k, [a.category, a.confidence]]));
    m.check(`#${n} answers`, got, result);
  }
}

export type PassCase = [
  "pass",
  number,
  string,
  ScenarioContext,
  ScenarioRow[],
  Request[],
  Reply[],
  { llm_error?: boolean; unknown_merchants?: number; llm_classified?: number; error?: string },
  [string, string, string, boolean][],
  Record<string, boolean>,
];

/** Python's acceptance (`cat in AUTO_CATEGORY_KEYS and cat != "other"`), to pin the pipeline before FIX(Q9). */
const pythonAccept = (cat: string): string | null =>
  AUTO_CATEGORY_KEYS.includes(cat) && cat !== "other" ? cat : null;

/** `categorize_all(use_llm=True)`: unknown merchants, request bodies, replies -> cached llm rules. */
export function checkPassCases(cases: readonly PassCase[], m: Mismatches, c: LlmCounts): void {
  for (const [, n, backend, sc, rows, requests, replies, outcome, rulesAfter] of cases) {
    c.passCases++;
    const ctx = scenarioContext(sc);
    const input = rows.map(categorizeRow);
    const out = categorizeAll(input, ctx, NOT_SUBSCRIPTION);
    const unknownInput = input.map((r, i) => {
      const eff = out.results.get(r.key) ?? null;
      const stored = (rows[i] as ScenarioRow)[12];
      // D-09.4: Python keeps a cash row's stored source; TS gives it no category.
      if (r.onCashAccount && eff === null && stored === "default") c.cashUnknown++;
      const source = r.onCashAccount && eff === null ? stored : (eff?.source ?? null);
      return { amount: r.amount, merchantKey: txnMerchantKey(r), source };
    });
    const unknown = unknownMerchants(unknownInput);
    const batches = tsBatches(backend, unknown, AUTO_CATEGORY_KEYS);
    const aborted = outcome.llm_error === true;
    const asked = requestedMerchants(backend, requests);
    m.check(`#${n} unknown`, aborted ? unknown.slice(0, asked.length) : unknown, asked);
    const hasPerson = unknown.some((u) => looksLikePerson(u));
    if (!(backend === "anthropic" && hasPerson)) {
      const sent = aborted ? batches.slice(0, requests.length) : batches;
      c.bodiesCompared += requests.length;
      m.check(
        `#${n} bodies`,
        sent.map((b) => b.body),
        requests.map(([, body]) => expandBody(body)),
      );
    }
    const { answers, malformed } = answersOf(
      backend,
      requests,
      replies,
      AUTO_CATEGORY_KEYS,
      ollamaMerchantBatches(unknown, AUTO_CATEGORY_KEYS).map((b) => b.ids),
    );
    if (outcome.llm_error && answers.size > 0 && malformed > 0) {
      c.q11Aborts++; // FIX(Q11): Python stored nothing after a non-object reply
      continue;
    }
    const rules = new Map<string, MerchantRule>(ctx.rules);
    if (!outcome.llm_error) {
      for (const [mk, a] of answers) {
        const cat = pythonAccept(a.category);
        if (cat === null) continue;
        if (cat === "transfer" || cat === "cash_withdrawal") c.q9Answers++;
        const up = ruleUpsert(rules.get(mk), mk, { category: cat, source: "llm", locked: false });
        if (up !== "keep") rules.set(mk, up);
      }
    }
    c.rulesCompared++;
    const got = [...rules.values()]
      .map((r) => [r.merchantKey, r.category, r.source, r.locked])
      .sort((a, b) =>
        (a[0] as string) < (b[0] as string) ? -1 : (a[0] as string) > (b[0] as string) ? 1 : 0,
      );
    m.check(`#${n} rules`, got, rulesAfter);
  }
}

export type ReclassifyScenario = [
  "scenario",
  number,
  ScenarioContext,
  ScenarioRow[],
  number[],
  { limit: number | null; dateFrom: string | null; dateTo: string | null },
  Request[],
  Reply[],
  {
    targets?: number;
    groups?: number;
    configured_txns?: number;
    classified_txns?: number;
    fallback_txns?: number;
    error?: string;
  },
  [string | null, string | null][],
];

function reclassifyRow(r: ScenarioRow): ReclassifyRow {
  const base = categorizeRow(r);
  return { ...base, category: r[11], source: r[12] };
}

const txnIds = (body: Body) =>
  ((body.messages as { content: string }[])[1]?.content ?? "")
    .split("\n")
    .filter((ln) => /^\[t\d+\]$/.test(ln)).length;

/** `reclassify_all` scenarios: the plan, the request bodies, the replies and the final rows. */
export function checkReclassifyScenarios(
  cases: readonly ReclassifyScenario[],
  m: Mismatches,
  c: LlmCounts,
): void {
  for (const [, n, sc, rows, order, opts, requests, replies, stats, final] of cases) {
    const ctx = scenarioContext(sc);
    const input = inQueryOrder(rows.map(reclassifyRow), order);
    const plan = planReclassify(input, ctx, {
      ...(opts.limit !== null ? { limit: opts.limit } : {}),
      ...(opts.dateFrom !== null ? { dateFrom: opts.dateFrom } : {}),
      ...(opts.dateTo !== null ? { dateTo: opts.dateTo } : {}),
    });
    const items = plan.groups.map((g) => [g.id, g.context] as const);
    const first = requests[0];
    // The generator picks batch_size 20 or 3; an aborted run (Q11) sent only its first batches.
    const batchSize = (requests.length > 1 || stats.error) && first ? txnIds(first[1]) : 20;
    const batches = ollamaTxnBatches(items, plan.allowedKeys, plan.allowedLabels, {
      model: "test-model",
      batchSize,
    });
    const sent = stats.error ? batches.slice(0, requests.length) : batches;
    m.check(
      `#${n} bodies`,
      sent.map((b) => b.body),
      requests.map(([, body]) => expandBody(body)),
    );
    c.bodiesCompared += requests.length;
    const answers = new Map<string, Answer>();
    let malformed = 0;
    batches.forEach((b, i) => {
      const reply = replies[i];
      if (reply === undefined || reply[0] === "status") return; // not sent (Q11 abort) or HTTP error
      const res = parseOllamaTxnReply(reply[1] as string, b.ids, plan.allowedKeys);
      if (!res.ok) malformed++;
      else for (const [k, a] of res.answers) answers.set(k, a);
    });
    if (stats.error) {
      c.q11Aborts++; // FIX(Q11): Python's reclassify died; TS fails the batch and goes on
      m.check(`#${n} malformed batch`, malformed > 0, true);
      continue;
    }
    m.check(
      `#${n} stats`,
      [plan.targets, plan.groups.length, plan.configured.length],
      [stats.targets, stats.groups, stats.configured_txns],
    );
    const byKey = new Map(input.map((r) => [r.key, r]));
    const { claims, fallback } = applyReclassify(plan, byKey, answers);
    const claimOf = new Map(claims.map((x) => [x.key, x.category]));
    const fallbackSet = new Set(fallback);
    const configured = new Map(plan.configured.map((x) => [x.key, x.result]));
    rows.forEach((r, i) => {
      const key = String(r[0]);
      const row = byKey.get(key) as ReclassifyRow;
      let got: [string | null, string | null] = [r[11], r[12]];
      const claim = claimOf.get(key);
      const conf = configured.get(key);
      if (claim !== undefined) got = [claim, "llm_full"];
      else if (fallbackSet.has(key)) {
        const e = categorize(row, ctx, new Set());
        got = [e.category, e.source];
      } else if (conf !== undefined) got = [conf.category, conf.source];
      m.check(`#${n} row ${key}`, got, final[i]);
    });
  }
}
