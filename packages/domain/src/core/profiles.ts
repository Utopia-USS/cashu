/**
 * Profile rules (`core/profiles.py`): slugs, the validation of profile fields and module choices,
 * and the display name of the default profile. Lookups and writes are store work; these are the
 * pure rules they apply.
 */

import { pyStrip, pyUpper } from "../text.js";
import { pickLabel, type UiLang } from "./i18n.js";
import { type CoreRegistry, withDependencies } from "./modules.js";

export const DEFAULT_SLUG = "default";
/** Polish UI data, stored; shown localized by `profileDisplayName`. */
export const DEFAULT_NAME = "Domyślny";
/** What an upstream installation used: the default profile created on demand gets these. */
export const UPSTREAM_MODULES: readonly string[] = Object.freeze(["budget", "assets", "loans"]);
export const PRIVACY_LEVELS = ["strict", "amounts"] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

const SLUG_MAX = 40;
const NAME_MAX = 80;

function stripDashes(s: string): string {
  return s.replace(/^-+|-+$/g, "");
}

/** `slugify`: ASCII slug of a display name: `"Jakub Łoś"` -> `"jakub-los"`; `"profil"` when empty. */
export function slugify(name: string): string {
  let text = name.replaceAll("ł", "l").replaceAll("Ł", "L").normalize("NFKD");
  // encode("ascii", "ignore"): every code point above U+007F is dropped.
  text = Array.from(text)
    .filter((ch) => (ch.codePointAt(0) as number) < 0x80)
    .join("");
  text = stripDashes(text.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  return stripDashes(text.slice(0, SLUG_MAX)) || "profil";
}

/** `unique_slug`: the slug of `name`, or the first free `<slug>-<n>` (n from 2) among `taken`. */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const base = slugify(name);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Invalid profile data (`ProfileError`, HTTP 422) or a clash with an existing profile
 * (`ProfileConflict`, HTTP 409). Messages are Python's (English).
 */
export type ProfileProblem =
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string };

export type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: ProfileProblem };

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const invalid = <T>(message: string): Checked<T> => ({
  ok: false,
  problem: { kind: "invalid", message },
});

/** `_clean_currency`: trimmed, upper-cased 3-letter code. */
export function cleanCurrency(value: string | null | undefined): Checked<string> {
  const cur = pyUpper(pyStrip(value ?? ""));
  if (!/^[A-Z]{3}$/.test(cur)) {
    return invalid("base_currency must be a 3-letter currency code (e.g. PLN)");
  }
  return ok(cur);
}

/** `_clean_name`: trimmed, required, at most 80 characters. */
export function cleanName(value: string | null | undefined): Checked<string> {
  const name = pyStrip(value ?? "");
  if (!name) return invalid("name is required");
  if (Array.from(name).length > NAME_MAX) {
    return invalid(`name is too long (max ${NAME_MAX} characters)`);
  }
  return ok(name);
}

/** `_clean_privacy`. */
export function cleanPrivacy(value: string): Checked<PrivacyLevel> {
  const level = PRIVACY_LEVELS.find((p) => p === value);
  if (level === undefined)
    return invalid(`mcp_privacy must be one of: ${PRIVACY_LEVELS.join(", ")}`);
  return ok(level);
}

/** `_clean_modules`: known ids only (deduplicated), plus their dependencies, in display order. */
export function cleanModules(
  registry: CoreRegistry,
  moduleIds: Iterable<string>,
): Checked<string[]> {
  const ids = [...new Set(moduleIds)];
  const unknown = ids.filter((m) => !registry.modules.has(m));
  if (unknown.length > 0) return invalid(`unknown module(s): ${unknown.join(", ")}`);
  return ok(withDependencies(registry, ids));
}

/**
 * Python's `str.casefold()` for profile names. JS has no full case folding; upper then lower case
 * matches it for the scripts names use (it folds `ß` to `ss` like casefold).
 */
export function casefold(s: string): string {
  return s.toUpperCase().toLowerCase();
}

export interface NamedProfile {
  readonly id: string;
  readonly name: string;
}

/** `_check_name_free`: names are unique ignoring case and surrounding whitespace. */
export function checkNameFree(
  profiles: readonly NamedProfile[],
  name: string,
  exceptId: string | null = null,
): Checked<string> {
  const folded = casefold(name);
  for (const p of profiles) {
    if (p.id !== exceptId && casefold(pyStrip(p.name)) === folded) {
      return {
        ok: false,
        problem: { kind: "conflict", message: `a profile named '${p.name}' already exists` },
      };
    }
  }
  return ok(name);
}

/**
 * `display_name`: the stored name, except the untouched default profile (slug `default` still named
 * "Domyślny"), whose name follows the UI language.
 */
export function profileDisplayName(profile: { slug: string; name: string }, lang: UiLang): string {
  if (profile.slug === DEFAULT_SLUG && profile.name === DEFAULT_NAME) {
    return pickLabel(lang, DEFAULT_NAME, "Default");
  }
  return profile.name;
}
