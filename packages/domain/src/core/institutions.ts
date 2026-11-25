/**
 * Institution registry: banks, brokers and exchanges an account can belong to
 * (`core/institutions.py`).
 *
 * `accounts.bank` stores an institution id from this registry (the upstream ids `mbank`, `erste`,
 * `pekao`, `manual` stay valid). An entry says how to recognise and read that institution's data:
 *
 * - `kind`: `bank` | `broker` | `exchange` | `manual`;
 * - `name`: display name; `nameEn` its English variant when it differs;
 * - `csvImporter`: key of its statement parser in the budget ingestion port (Python: a lazily
 *   imported `"package.module:ClassName"`); null = no CSV import yet;
 * - `aspspPatterns`: lowercase substrings of the Enable Banking ASPSP name that map an Open Banking
 *   session to this institution.
 */

import { isCombining, PY_WS, pyLower, pyUpper } from "../text.js";
import { RegistryConflictError } from "./accountTypes.js";
import { pickLabel, type UiLang } from "./i18n.js";

export type InstitutionKind = "bank" | "broker" | "exchange" | "manual";

/** Manually tracked positions, the cash pool, loans without a bank feed. */
export const MANUAL_INSTITUTION = "manual";

export interface Institution {
  readonly id: string;
  readonly kind: InstitutionKind;
  readonly name: string;
  readonly csvImporter: string | null;
  readonly aspspPatterns: readonly string[];
  readonly country: string;
  readonly nameEn: string | null;
}

/** `Institution(id, kind, name, csv_importer=None, aspsp_patterns=(), country="PL", name_en=None)`. */
export function institution(
  id: string,
  kind: InstitutionKind,
  name: string,
  opts: Partial<Pick<Institution, "csvImporter" | "aspspPatterns" | "country" | "nameEn">> = {},
): Institution {
  return Object.freeze({
    id,
    kind,
    name,
    csvImporter: opts.csvImporter ?? null,
    aspspPatterns: Object.freeze([...(opts.aspspPatterns ?? [])]),
    country: opts.country ?? "PL",
    nameEn: opts.nameEn ?? null,
  });
}

export const BUILTIN_INSTITUTIONS: readonly Institution[] = Object.freeze([
  institution("mbank", "bank", "mBank", { csvImporter: "mbank", aspspPatterns: ["mbank"] }),
  // Erste Bank Polska = the former Santander Bank Polska (legacy exports too).
  institution("erste", "bank", "Erste Bank Polska", {
    csvImporter: "erste",
    aspspPatterns: ["erste", "santander"],
  }),
  institution("pekao", "bank", "Bank Pekao", { csvImporter: "pekao", aspspPatterns: ["pekao"] }),
  // Open Banking only until the CSV parser lands (needs a sample export).
  institution("millennium", "bank", "Bank Millennium", { aspspPatterns: ["millennium"] }),
  // Open Banking only (no CSV parser).
  institution("revolut", "bank", "Revolut", { aspspPatterns: ["revolut"] }),
  institution(MANUAL_INSTITUTION, "manual", "Ręcznie", { nameEn: "Manual" }),
]);

/** `UnknownInstitution` (a `KeyError` in Python). */
export class UnknownInstitutionError extends Error {
  constructor(id: string) {
    super(`Unknown institution '${id}'`);
    this.name = "UnknownInstitutionError";
  }
}

function sameInstitution(a: Institution, b: Institution): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.name === b.name &&
    a.csvImporter === b.csvImporter &&
    a.country === b.country &&
    a.nameEn === b.nameEn &&
    a.aspspPatterns.length === b.aspspPatterns.length &&
    a.aspspPatterns.every((p, i) => p === b.aspspPatterns[i])
  );
}

/** The institution id rule: `^[a-z][a-z0-9_-]{0,31}$` (`canonical.INSTITUTION_PATTERN`). */
export const INSTITUTION_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_ID = 32;
const NO_DECOMPOSITION: Readonly<Record<string, string>> = {
  ł: "l",
  Ł: "L",
  ø: "o",
  Ø: "O",
  ß: "ss",
  đ: "d",
};
const WORD_SEPARATORS = new RegExp(`[-_${PY_WS}]+`, "u");

/**
 * `slug_id`: a generic institution id from a free-form name: lower case, ASCII, words joined by "-",
 * at most 32 characters, starting with a letter ("ING Bank Śląski S.A." -> "ing-bank-slaski-s-a").
 * Empty when the name holds no letters or digits.
 */
export function slugId(name: string | null | undefined): string {
  let translated = "";
  for (const ch of name ?? "") translated += NO_DECOMPOSITION[ch] ?? ch;
  let stripped = "";
  for (const ch of translated.normalize("NFKD")) {
    if (!isCombining(ch.codePointAt(0) as number)) stripped += ch;
  }
  let slug = pyLower(stripped)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug && !/^[a-z]/.test(slug)) slug = `bank-${slug}`;
  return slug.slice(0, MAX_ID).replace(/-+$/, "");
}

export class InstitutionRegistry {
  private readonly byId = new Map<string, Institution>();

  constructor(initial: readonly Institution[] = BUILTIN_INSTITUTIONS) {
    for (const inst of initial) this.register(inst);
  }

  /** `register`: the same entry again is fine, a different one under the same id throws. */
  register(inst: Institution): void {
    const current = this.byId.get(inst.id);
    if (current !== undefined && !sameInstitution(current, inst)) {
      throw new RegistryConflictError(`Institution '${inst.id}' is already registered`);
    }
    this.byId.set(inst.id, inst);
  }

  /** `get`: throws `UnknownInstitutionError` for an id no entry knows. */
  get(id: string): Institution {
    const inst = this.byId.get(id);
    if (inst === undefined) throw new UnknownInstitutionError(id);
    return inst;
  }

  find(id: string): Institution | undefined {
    return this.byId.get(id);
  }

  /** `all_institutions`, in registration order (built-ins first, then module entries). */
  all(kind?: InstitutionKind): Institution[] {
    return [...this.byId.values()].filter((i) => kind === undefined || i.kind === kind);
  }

  ids(kind?: InstitutionKind): string[] {
    return this.all(kind).map((i) => i.id);
  }

  /** `csv_ids`: institutions whose statements can be imported from CSV. */
  csvIds(): string[] {
    return this.all()
      .filter((i) => i.csvImporter)
      .map((i) => i.id);
  }

  /**
   * `display_name`: the name in the UI language; for an id no entry knows (an Open Banking bank
   * without an entry, an imported institution id) its words, capitalized: "ing-bank-slaski" ->
   * "Ing Bank Slaski". Never throws.
   */
  displayName(id: string, lang: UiLang): string {
    const inst = this.byId.get(id);
    if (inst !== undefined) return pickLabel(lang, inst.name, inst.nameEn);
    const words = (id || "").split(WORD_SEPARATORS).filter((w) => w);
    const out = words.map((w) => {
      const [first = "", ...rest] = Array.from(w);
      return pyUpper(first) + rest.join("");
    });
    return out.join(" ") || id || "";
  }

  /** `from_aspsp`: the institution an Enable Banking ASPSP name belongs to (first pattern hit). */
  fromAspsp(aspspName: string | null | undefined): Institution | null {
    const low = pyLower(aspspName ?? "");
    if (!low) return null;
    for (const inst of this.byId.values()) {
      if (inst.aspspPatterns.some((p) => low.includes(p))) return inst;
    }
    return null;
  }

  /**
   * `enable_banking.sync.bank_from_aspsp`: the registry entry whose patterns match, else a generic id
   * slugged from the ASPSP name; a slug that is already another institution's id gets an "ob-"
   * prefix. null (Python: ValueError "pass bank explicitly") for a name with nothing to slug.
   */
  bankFromAspsp(aspspName: string | null | undefined): string | null {
    const inst = this.fromAspsp(aspspName);
    if (inst !== null) return inst.id;
    let slug = slugId(aspspName ?? "");
    if (!slug) return null;
    if (this.byId.has(slug)) slug = slugId(`ob-${slug}`);
    return slug;
  }
}
