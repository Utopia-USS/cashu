// Typed start-up failures (T54 recovery screen). A failure is a code from a closed catalog, the stage
// it happened in, an optional detail from a closed allow-list, a flag saying whether the user's
// original files stayed untouched, and count-only facts. Nothing else crosses: error messages, paths
// and log text never become part of a failure. The host writes a failure record before it exits,
// Electron main reads it (zod-validated, it is a file read across a trust boundary) and shows the
// recovery screen. Main also enters it by itself when it finds the old (Python) app's data.

/** What went wrong, in the words the recovery screen and the agent prompt explain. */
export const STARTUP_FAILURE_CODES = [
  "python_data_present",
  "native_inventory_unavailable",
  "vault_key_unavailable",
  "view_rebuild_failed",
  "unknown",
] as const;
export type StartupFailureCode = (typeof STARTUP_FAILURE_CODES)[number];

/** Where in the start sequence it happened. */
export const STARTUP_STAGES = [
  "admission",
  "inventory",
  "vault_open",
  "view_rebuild",
  "host_start",
] as const;
export type StartupStage = (typeof STARTUP_STAGES)[number];

interface CodeSpec {
  readonly stage: StartupStage;
  /**
   * Whether every check on this path only reads the user's original files (the Python data, the
   * vault files and keys, the encrypted history), so the screen may say they are untouched.
   */
  readonly originalsUntouched: boolean;
}

export const STARTUP_FAILURE_SPECS: Readonly<Record<StartupFailureCode, CodeSpec>> = {
  // Existence checks only (lstat); the Python database is never opened, moved or changed.
  python_data_present: { stage: "admission", originalsUntouched: true },
  // Inventory and creation journal reads are read-only and refuse before any write.
  native_inventory_unavailable: { stage: "inventory", originalsUntouched: true },
  // The key ring is read, the private metadata database is probed read-only.
  vault_key_unavailable: { stage: "vault_open", originalsUntouched: true },
  // A rebuild runs in one transaction that rolls back; the encrypted history is never rewritten.
  view_rebuild_failed: { stage: "view_rebuild", originalsUntouched: true },
  // Nothing is known about the path, so nothing is promised.
  unknown: { stage: "host_start", originalsUntouched: false },
};

/**
 * Short internal codes that may travel with a failure as its detail. Each maps to the failure code
 * and the stage it stands for; a thrown message that is not listed here is never echoed.
 */
export const STARTUP_FAILURE_DETAILS = {
  // The old (Python) app's data in the data folder, and no native profile yet.
  python_data_found: ["python_data_present", "admission"],
  // Native vault inventory and setup state.
  native_vault_provider_unavailable: ["native_inventory_unavailable", "admission"],
  native_inventory_unavailable: ["native_inventory_unavailable", "inventory"],
  native_inventory_invalid: ["native_inventory_unavailable", "inventory"],
  native_inventory_changed: ["native_inventory_unavailable", "inventory"],
  native_setup_required: ["native_inventory_unavailable", "inventory"],
  native_provisioning_pending: ["native_inventory_unavailable", "inventory"],
  native_preflight_required: ["native_inventory_unavailable", "inventory"],
  native_creation_ambiguous: ["native_inventory_unavailable", "inventory"],
  native_creation_journal_invalid: ["native_inventory_unavailable", "inventory"],
  native_creation_path_invalid: ["native_inventory_unavailable", "inventory"],
  native_vault_unavailable: ["native_inventory_unavailable", "vault_open"],
  native_path_invalid: ["native_inventory_unavailable", "vault_open"],
  native_metadata_unavailable: ["native_inventory_unavailable", "vault_open"],
  // Vault keys: missing from the OS key store, or present but not decryptable.
  native_authority_unavailable: ["vault_key_unavailable", "vault_open"],
  keystore_corrupt: ["vault_key_unavailable", "vault_open"],
  keystore_unavailable: ["vault_key_unavailable", "vault_open"],
  // The view could not be rebuilt from the held history.
  view_rebuild_failed: ["view_rebuild_failed", "view_rebuild"],
  // Known refusals with no recovery story of their own.
  bundle_identity_unavailable: ["unknown", "host_start"],
  native_host_lock_required: ["unknown", "host_start"],
  device_rotation_required: ["unknown", "vault_open"],
} as const satisfies Record<string, readonly [StartupFailureCode, StartupStage]>;
export type StartupFailureDetail = keyof typeof STARTUP_FAILURE_DETAILS;
export const STARTUP_FAILURE_DETAIL_NAMES = Object.keys(
  STARTUP_FAILURE_DETAILS,
) as StartupFailureDetail[];

/** Count-only facts. Every field is a small non-negative integer; nothing else is ever stored. */
export const STARTUP_FACT_KEYS = ["vaults", "pythonSources", "recentCrashes"] as const;
type StartupFactKey = (typeof STARTUP_FACT_KEYS)[number];
export type StartupFacts = Partial<Record<StartupFactKey, number>>;

/** One classified failure (what the host records). */
export interface StartupFailure {
  readonly code: StartupFailureCode;
  readonly stage: StartupStage;
  readonly detail?: StartupFailureDetail;
  readonly originalsUntouched: boolean;
  readonly facts: StartupFacts;
}

function isDetail(value: unknown): value is StartupFailureDetail {
  return typeof value === "string" && Object.hasOwn(STARTUP_FAILURE_DETAILS, value);
}

function isCode(value: unknown): value is StartupFailureCode {
  return typeof value === "string" && (STARTUP_FAILURE_CODES as readonly string[]).includes(value);
}

/** Only the allow-listed fact keys, each a safe integer in 0..1_000_000; anything else is dropped. */
export function countFacts(input: unknown): StartupFacts {
  const facts: StartupFacts = {};
  if (typeof input !== "object" || input === null) return facts;
  for (const key of STARTUP_FACT_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000)
      facts[key] = value as number;
  }
  return facts;
}

/** A failure from a code and an optional detail; the stage is the detail's, else the code's. */
export function startupFailure(
  code: StartupFailureCode,
  detail?: StartupFailureDetail,
  facts: StartupFacts = {},
): StartupFailure {
  const stage =
    detail !== undefined && STARTUP_FAILURE_DETAILS[detail][0] === code
      ? STARTUP_FAILURE_DETAILS[detail][1]
      : STARTUP_FAILURE_SPECS[code].stage;
  return {
    code,
    stage,
    ...(detail === undefined ? {} : { detail }),
    originalsUntouched: STARTUP_FAILURE_SPECS[code].originalsUntouched,
    facts: countFacts(facts),
  };
}

/**
 * A start-up refusal with a typed code. The message is the detail (else the code), so callers that
 * compare `error.message` with an internal code keep working; it never carries a value.
 */
export class StartupFailureError extends Error {
  readonly failure: StartupFailure;
  constructor(code: StartupFailureCode, detail?: StartupFailureDetail, facts?: StartupFacts) {
    super(detail ?? code);
    this.name = "StartupFailureError";
    this.failure = startupFailure(code, detail, facts);
  }
}

const SHORT_CODE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * A short code for a thrown value: a typed string `code` field, else a snake_case message of at most
 * 64 characters, else "?". Shared with the host's vault refusal diagnostics (nativeVault/diagnostics.ts).
 */
export function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "?";
  if ("code" in error && typeof error.code === "string" && SHORT_CODE.test(error.code))
    return error.code;
  if (
    error instanceof Error &&
    error.message.length <= 64 &&
    /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/.test(error.message)
  )
    return error.message;
  return "?";
}

/** The allow-listed detail a thrown value carries (its typed `code`, else its message), if any. */
function failureDetail(error: unknown): StartupFailureDetail | undefined {
  const code = errorCode(error);
  return isDetail(code) ? code : undefined;
}

/**
 * The failure a thrown value stands for. A `StartupFailureError` keeps its own; any other value is
 * mapped only through the detail allow-list (its typed `code`, else its message); everything else is
 * `unknown` with no detail. Facts come from the caller, never from the error.
 */
export function classifyStartupError(error: unknown, facts: StartupFacts = {}): StartupFailure {
  if (error instanceof StartupFailureError) {
    const own = error.failure;
    return startupFailure(own.code, own.detail, { ...own.facts, ...countFacts(facts) });
  }
  const detail = failureDetail(error);
  if (detail !== undefined)
    return startupFailure(STARTUP_FAILURE_DETAILS[detail][0], detail, facts);
  const code = errorCode(error);
  if (isCode(code)) return startupFailure(code, undefined, facts);
  return startupFailure("unknown", undefined, facts);
}
