// The generic allocation interface (owner decision F7-generic), shared by the desktop and the phone: the
// owner's own strategy buckets are internal knowledge for the agent, so the app names, targets and
// signals only generic buckets (template and plain asset-class ids, labels.ts). A missing server flag
// counts as generic; an id the app cannot name counts as not generic, so no bucket id is ever rendered
// raw. Pure and light (labels only): the phone bundle imports it without the desktop's v2 logic.

import { BUCKET_FN as BUCKET_FN_L } from "./buckets.strings.js";
import { bucketLabel, GENERIC_BUCKET_IDS, isGenericBucket } from "./labels.js";

/** The part of a signal the bucket rules read. */
export interface BucketSignal {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Whether a signal shows anywhere in the app (lists, counts, links): every signal except an allocation drift of
 * a non-generic bucket (`payload.bucket_generic === false`, or an id without a generic label). */
export function isShownSignal(sig: BucketSignal): boolean {
  if (sig.kind !== "allocation_drift") return true;
  const id = typeof sig.payload?.bucket_id === "string" ? sig.payload.bucket_id : null;
  return sig.payload?.bucket_generic !== false && isGenericBucket(id);
}

/** Expression bucket functions over a non-generic bucket, shown as a phrase instead of the call. */
const BUCKET_FN: Record<string, string> = BUCKET_FN_L;
/** ASCII words that may follow "koszyk" / "bucket" in owner-written text and are never bucket ids. */
const NOT_BUCKET_IDS = new Set([
  "na",
  "do",
  "od",
  "nad",
  "pod",
  "ponad",
  "w",
  "z",
  "i",
  "o",
  "za",
  "przy",
  "bez",
  "ma",
  "jest",
  "waga",
  "udzial",
  "akcji",
  "obligacji",
  "gotowki",
  "przekracza",
  "spada",
  "rosnie",
  "powyzej",
  "ponizej",
  "is",
  "at",
  "of",
  "in",
  "to",
  "from",
  "over",
  "under",
  "above",
  "below",
  "weight",
  "share",
  "exceeds",
  "falls",
  "rises",
  "has",
  // The English phrases of BUCKET_FN ("bucket drift", "bucket target", "bucket value").
  "drift",
  "target",
  "value",
]);
const ID_LIKE = /^[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)*$/;
let labelWords: Set<string> | null = null;
/** First words of the generic labels (`Akcje`, `Obligacje`, `ETF-y`, ...): already a label, never an id. */
const isLabelWord = (w: string) => {
  labelWords ??= new Set(
    GENERIC_BUCKET_IDS.map((id) => ((bucketLabel(id) ?? "").split(" ")[0] ?? "").toLowerCase()),
  );
  return labelWords.has(w.toLowerCase());
};

/** Texts that may carry the owner's bucket ids, made safe to show (F7-generic, FE-A A2 / A3): server-built prose
 * (`Koszyk core: ...` from a bucket-scoped custom rule, `Koszyk core` as an alert subject; any case) gets the generic
 * label or drops the id (`Koszyk: ...`); expression text (custom-rule default messages `Warunek spełniony: <when>`,
 * custom alert expressions) shows `bucket_drift_pp("core")` as `dryf koszyka` (likewise waga / cel / wartość
 * koszyka) and a `bucket_id == "core"` literal as `"…"`. Generic ids stay as written; idempotent. */
export function unnameBuckets(text: string): string {
  return text
    .replace(
      /\b(bucket_(?:weight|target|drift_pp|value))\(\s*(["'])([^"']*)\2\s*\)/g,
      (m, fn: string, _q: string, id: string) => (isGenericBucket(id) ? m : (BUCKET_FN[fn] ?? m)),
    )
    .replace(/\bbucket_id(\s*[!=]=\s*)(["'])([^"']*)\2/g, (m, op: string, q: string, id: string) =>
      isGenericBucket(id) || id === "…" ? m : `bucket_id${op}${q}…${q}`,
    )
    .replace(/(["'])([^"']*)\1(\s*[!=]=\s*)bucket_id\b/g, (m, q: string, id: string, op: string) =>
      isGenericBucket(id) || id === "…" ? m : `${q}…${q}${op}bucket_id`,
    )
    .replace(
      /\b([Kk]oszyk|[Bb]ucket) ([^\s:,;()"']+)(?=([:\s,;)]|$))/g,
      (m, kw: string, tok: string, next: string) => {
        if (isLabelWord(tok)) return m;
        const id = next === ":" || (ID_LIKE.test(tok) && !NOT_BUCKET_IDS.has(tok.toLowerCase()));
        if (!id) return m;
        const l = bucketLabel(tok);
        return l ? `${kw} ${l}` : kw;
      },
    );
}

/** Whether the allocation's buckets (targets, drift, `Koszyki`) may show: at least one bucket and every bucket
 * generic (`buckets_generic` / `generic` from the server, a missing key = generic, plus a generic label). */
export function allocGeneric(alloc: {
  readonly buckets: readonly { readonly bucket_id: string; readonly generic?: boolean | null }[];
  readonly buckets_generic?: boolean | null;
}): boolean {
  return (
    alloc.buckets.length > 0 &&
    alloc.buckets_generic !== false &&
    alloc.buckets.every((b) => b.generic !== false && isGenericBucket(b.bucket_id))
  );
}
