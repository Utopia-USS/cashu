// Side files of the data dir genesis reads (S26 spec 2.1, 4.3, 4.4 archive, 4.8 D-G7): the budget
// settings (`profiles/<slug>/budget.json`, parsed with the leniency of Python
// `modules/budget/settings.py:load` / `parse`), the strategy files (compared with the latest stored
// version, never an event), and the archive blob ref of an investment import. Counters only, never
// values; every path is relative to the data dir and read through `GenesisFiles`.
import { D, type Decimal, floatRepr, pyStrip, pyUpper } from "@cashu/domain";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isJsonObject } from "./idFields.js";
import type { InvImportBatchRow } from "./rows.js";
import type { GenesisFiles } from "./source.js";

/** `settings.py` CushionSettings after `parse`: decimals quantized to 0.01, ids deduplicated. */
export interface Cushion {
  readonly enabled: boolean;
  readonly currency: string | null;
  readonly targetAmount: string | null;
  readonly targetMonths: number | null;
  readonly accountIds: readonly number[];
  readonly monthlyMax: string | null;
}

/** A missing file: Python's defaults, no event (spec 4.3). Invalid: also the defaults, counted. */
type CushionFile =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly cushion: Cushion };

const MAX_TARGET_MONTHS = 36;
const CURRENCY_RE = /^[A-Z]{3}$/;
const CENT = D("0.01");
const DEFAULT_CUSHION: Cushion = {
  enabled: false,
  currency: null,
  targetAmount: null,
  targetMonths: null,
  accountIds: [],
  monthlyMax: null,
};

class InvalidSettings extends Error {}

const isBlank = (v: unknown) => v === "" || v === null || v === undefined;

/** `settings.py:_positive`: a positive number (JSON number or text), quantized to 0.01. */
function positive(value: unknown): string | null {
  if (isBlank(value)) return null;
  let number: Decimal;
  try {
    // Python `Decimal(str(value))`: a JSON float renders as its repr (events.md 4.3, m13).
    if (typeof value === "number") number = D(floatRepr(value));
    else if (typeof value === "string") number = D(value);
    else throw new InvalidSettings();
    if (number.isZero() || number.isSigned()) throw new InvalidSettings();
    return number.quantize(CENT).format("f");
  } catch {
    throw new InvalidSettings();
  }
}

function targetMonths(value: unknown): number | null {
  if (isBlank(value)) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new InvalidSettings();
  if (value < 1 || value > MAX_TARGET_MONTHS) throw new InvalidSettings();
  return value;
}

function accountIds(value: unknown): readonly number[] {
  // Python `cushion.get("account_ids") or []`: every falsy value is the empty list.
  const empty = isJsonObject(value) && Object.keys(value).length === 0;
  const ids = value === 0 || value === false || empty || isBlank(value) ? [] : value;
  if (!Array.isArray(ids)) throw new InvalidSettings();
  const out: number[] = [];
  for (const id of ids) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new InvalidSettings();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** `settings.py:parse` (unknown keys ignored); throws `InvalidSettings` where Python raises. */
function parseCushion(raw: unknown): Cushion {
  if (raw === null) return DEFAULT_CUSHION;
  if (!isJsonObject(raw)) throw new InvalidSettings();
  const cushion = raw.cushion;
  if (cushion === null || cushion === undefined) return DEFAULT_CUSHION;
  if (!isJsonObject(cushion)) throw new InvalidSettings();
  // Python `cushion.get("enabled", False)`: only a missing key defaults; null is not a bool.
  const enabled = "enabled" in cushion ? cushion.enabled : false;
  if (typeof enabled !== "boolean") throw new InvalidSettings();
  let currency: string | null = null;
  if (!isBlank(cushion.currency)) {
    if (typeof cushion.currency !== "string") throw new InvalidSettings();
    currency = pyUpper(pyStrip(cushion.currency));
    if (!CURRENCY_RE.test(currency)) throw new InvalidSettings();
  }
  const targetAmount = positive(cushion.target_amount);
  const monthlyMax = positive(cushion.monthly_max);
  const months = targetMonths(cushion.target_months);
  const ids = accountIds(cushion.account_ids);
  if (enabled && targetAmount === null && months === null) throw new InvalidSettings();
  return { enabled, currency, targetAmount, targetMonths: months, accountIds: ids, monthlyMax };
}

/** The cushion of `profiles/<slug>/budget.json` (`settings.py:load`: unreadable = defaults). */
export function readCushion(files: GenesisFiles, slug: string): CushionFile {
  const bytes = files.read(`profiles/${slug}/budget.json`);
  if (bytes === undefined) return { kind: "missing" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { kind: "ok", cushion: parseCushion(JSON.parse(text)) };
  } catch {
    return { kind: "invalid" };
  }
}

const utf8 = new TextEncoder();

function sameBytes(file: Uint8Array | undefined, text: string | null | undefined): boolean {
  if (file === undefined || text === null || text === undefined) {
    return file === undefined && (text === null || text === undefined);
  }
  const expected = utf8.encode(text);
  return file.length === expected.length && file.every((b, i) => b === expected[i]);
}

/**
 * D-G7: how many of `strategy.yaml` / `strategy.md` differ (bytes, UTF-8) from the latest stored
 * version (a file without a version, or a version text without its file, differs).
 */
export function strategyFilesDiffering(
  files: GenesisFiles,
  slug: string,
  latest: { readonly yamlText: string; readonly mdText: string | null } | undefined,
): number {
  const yaml = files.read(`profiles/${slug}/strategy.yaml`);
  const md = files.read(`profiles/${slug}/strategy.md`);
  return (sameBytes(yaml, latest?.yamlText) ? 0 : 1) + (sameBytes(md, latest?.mdText) ? 0 : 1);
}

/** An archive file name: `<sha256>.<ext>` (Python `imports/<slug>/<sha>.<ext>`). */
const ARCHIVE_NAME = /^([0-9a-f]{64})\.([^./]+)$/;
const EXT_RE = /^[a-z0-9]{1,10}$/;

/**
 * Spec 4.4: the `archive` blob of an investment import, emitted only when the file exists and the
 * sha256 of its bytes equals both its name's digest and `file_sha256`. Otherwise undefined and
 * counted through `tally` (`archive_invalid`, `archive_missing`, `archive_hash_mismatch`). A batch
 * without `archive_path` has no archive and no count.
 */
export function archiveRef(
  files: GenesisFiles,
  row: InvImportBatchRow,
  tally: (reason: string) => void,
): { readonly sha256: string; readonly ext: string } | undefined {
  const path = row.archivePath;
  if (path === null) return undefined;
  const m = ARCHIVE_NAME.exec(path.split("/").pop() ?? "");
  const ext = (m?.[2] ?? "").toLowerCase();
  const safe = !path.startsWith("/") && !path.split("/").includes("..");
  if (m === null || !safe || !EXT_RE.test(ext)) {
    tally("archive_invalid");
    return undefined;
  }
  const bytes = files.read(path);
  if (bytes === undefined) {
    tally("archive_missing");
    return undefined;
  }
  const digest = bytesToHex(sha256(bytes));
  if (digest !== m[1] || digest !== row.fileSha256) {
    tally("archive_hash_mismatch");
    return undefined;
  }
  return { sha256: digest, ext };
}
