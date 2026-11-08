/**
 * Module registry: the contract every module implements (`core/modules.py`, `ModuleSpec`).
 *
 * The TS spec keeps the pure, declarative half of Python's `ModuleSpec`: names, dependencies, the
 * account types / net-worth buckets / institutions it registers and the categorization hooks.
 * Python's runtime parts (tables, FastAPI router, Typer CLI, `setup_status`, `recategorize`,
 * `payment_patterns`) belong to the store and app layers. `networth` says whether the module values
 * the accounts it owns; the contributor itself is built per call by the store with the module's
 * loaded rows (see `NetWorthContributor` in `valuation.ts`) and handed to net worth in module order
 * (`orderContributors`).
 */

import { type AccountTypeInfo, AccountTypeRegistry, type NetWorthBucket } from "./accountTypes.js";
import { pickLabel, type UiLang } from "./i18n.js";
import { type Institution, InstitutionRegistry } from "./institutions.js";
import type { NetWorthContributor } from "./valuation.js";

/** Display order (wizard cards, tab groups). Module ids are also package folder names. */
export const MODULE_IDS = ["budget", "assets", "loans", "investments"] as const;

export interface ModuleSpec {
  readonly id: string;
  /** Polish (UI data; MCP, CLI). */
  readonly name: string;
  /** Polish (UI data; MCP, CLI). */
  readonly description: string;
  readonly nameEn: string | null;
  readonly descriptionEn: string | null;
  /** Other module ids, enabled together. */
  readonly dependsOn: readonly string[];
  /** False: listed (wizard) but not implemented in this build. */
  readonly available: boolean;
  /** CLI sub-app name when it is not the id (`cashu invest ...`). */
  readonly cliName: string | null;
  /** The module values the accounts it owns (Python: a `NetWorthContributor` on the spec). */
  readonly networth: boolean;
  readonly accountTypes: readonly AccountTypeInfo[];
  readonly networthBuckets: readonly NetWorthBucket[];
  /** Extra institutions (e.g. brokers). */
  readonly institutions: readonly Institution[];
  /** `(phrase in normalized text, category)` rules for budget categorization (Polish matching data). */
  readonly textRules: readonly (readonly [string, string])[];
  readonly notSubscriptionCategories: readonly string[];
  /** Claude Code setup skill command, e.g. "/budget-setup". */
  readonly skill: string | null;
}

type SpecInit = Pick<ModuleSpec, "id" | "name" | "description"> & Partial<ModuleSpec>;

/** `ModuleSpec(...)` with Python's defaults for every field not given. */
export function moduleSpec(init: SpecInit): ModuleSpec {
  return Object.freeze({
    nameEn: null,
    descriptionEn: null,
    dependsOn: [],
    available: true,
    cliName: null,
    networth: false,
    accountTypes: [],
    networthBuckets: [],
    institutions: [],
    textRules: [],
    notSubscriptionCategories: [],
    skill: null,
    ...init,
  });
}

/** `display_name()`: the name in the UI language. */
export function moduleName(spec: ModuleSpec, lang: UiLang): string {
  return pickLabel(lang, spec.name, spec.nameEn);
}

/** `display_description()`: the description in the UI language. */
export function moduleDescription(spec: ModuleSpec, lang: UiLang): string {
  return pickLabel(lang, spec.description, spec.descriptionEn);
}

// --------------------------------------------------------------------------- setup status

export type StepStatus = "done" | "on" | "todo";
export type SetupState = "empty" | "partial" | "ready";

export interface SetupAction {
  /** "cli" (target = a command to run) | "view" (target = a frontend view id). */
  readonly kind: string;
  /** UI text in the request's language. */
  readonly label: string;
  readonly target: string;
}

export interface SetupStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly done: boolean;
  readonly actions: readonly SetupAction[];
  /** An optional step never counts toward the module state and is never "on". */
  readonly optional: boolean;
}

export interface SetupStepDict {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: StepStatus;
  readonly optional: boolean;
  readonly actions: readonly SetupAction[];
}

/** `SetupStatus.state`: required steps only; "ready" when every one is done, "empty" when none is. */
export function setupState(steps: readonly SetupStep[]): SetupState {
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  if (required.length > 0 && done === required.length) return "ready";
  return done > 0 ? "partial" : "empty";
}

/** `SetupStatus.step_dicts()`: the first required step not done is "on", the rest "todo". */
export function setupStepDicts(steps: readonly SetupStep[]): SetupStepDict[] {
  let currentGiven = false;
  return steps.map((s) => {
    let status: StepStatus;
    if (s.done) status = "done";
    else if (!currentGiven && !s.optional) {
      status = "on";
      currentGiven = true;
    } else status = "todo";
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      status,
      optional: s.optional,
      actions: s.actions.map((a) => ({ kind: a.kind, label: a.label, target: a.target })),
    };
  });
}

/**
 * A payment a module owns, for categorization: an outflow to `counterpartyIban` or whose text
 * contains `text` (normalized: uppercase, no diacritics) gets `category`.
 */
export interface PaymentPattern {
  readonly category: string;
  /** Compared by `ibanKey`. */
  readonly counterpartyIban: string | null;
  readonly text: string | null;
}

// --------------------------------------------------------------------------- registry

/** `modules.registry()` plus the account type and institution registries it fills. */
export interface CoreRegistry {
  /** All known modules, in display order. */
  readonly modules: ReadonlyMap<string, ModuleSpec>;
  readonly accountTypes: AccountTypeRegistry;
  readonly institutions: InstitutionRegistry;
}

export class UnknownModuleError extends Error {
  constructor(id: string) {
    super(`Unknown module '${id}'`);
    this.name = "UnknownModuleError";
  }
}

/**
 * Build the registries from module specs (`registry()` + `_register_metadata` for each, in order).
 * A conflicting account type, bucket or institution throws `RegistryConflictError`.
 */
export function createCoreRegistry(specs: readonly ModuleSpec[]): CoreRegistry {
  const modules = new Map<string, ModuleSpec>();
  const accountTypes = new AccountTypeRegistry();
  const institutions = new InstitutionRegistry();
  for (const spec of specs) {
    modules.set(spec.id, spec);
    for (const b of spec.networthBuckets) accountTypes.registerBucket(b);
    for (const t of spec.accountTypes) accountTypes.registerType(t);
    for (const inst of spec.institutions) institutions.register(inst);
  }
  return { modules, accountTypes, institutions };
}

/** `modules.get`: throws `UnknownModuleError`. */
export function getModule(registry: CoreRegistry, id: string): ModuleSpec {
  const spec = registry.modules.get(id);
  if (spec === undefined) throw new UnknownModuleError(id);
  return spec;
}

/** `with_dependencies`: `moduleIds` plus everything they depend on, in display order. */
export function withDependencies(registry: CoreRegistry, moduleIds: readonly string[]): string[] {
  const wanted = new Set<string>();
  const stack = [...moduleIds];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (wanted.has(id)) continue;
    wanted.add(id);
    stack.push(...getModule(registry, id).dependsOn);
  }
  return [...registry.modules.keys()].filter((m) => wanted.has(m));
}

/** `text_rules`: static (phrase, category) rules registered by modules, in module order. */
export function textRules(registry: CoreRegistry): (readonly [string, string])[] {
  return [...registry.modules.values()].flatMap((spec) => [...spec.textRules]);
}

/** `not_subscription_categories`: categories that are never subscriptions, from every module. */
export function notSubscriptionCategories(registry: CoreRegistry): Set<string> {
  const out = new Set<string>();
  for (const spec of registry.modules.values()) {
    for (const c of spec.notSubscriptionCategories) out.add(c);
  }
  return out;
}

/**
 * Contributors in module display order, for `NetWorthBook.contributors` (Python iterates
 * `all_modules()`; the first module that values an account wins). Unknown module ids throw.
 */
export function orderContributors(
  registry: CoreRegistry,
  byModule: Readonly<Record<string, NetWorthContributor>>,
): NetWorthContributor[] {
  for (const id of Object.keys(byModule)) getModule(registry, id);
  const out: NetWorthContributor[] = [];
  for (const id of registry.modules.keys()) {
    const contributor = byModule[id];
    if (contributor !== undefined) out.push(contributor);
  }
  return out;
}
