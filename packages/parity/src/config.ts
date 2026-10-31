/// <reference types="node" />
import { readFileSync } from "node:fs";
import { type CompareOptions, DEFAULT_OPTIONS } from "./compare.ts";
import type { DecimalPolicy } from "./decimal.ts";

/** Per-check overrides; every field is optional and falls back to `default`, then the built-ins. */
export interface CheckOverride {
  absTol?: number;
  relTol?: number;
  decimal?: DecimalPolicy;
}

export interface ParityConfig {
  default: CheckOverride;
  checks: Record<string, CheckOverride>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const OVERRIDE_KEYS = new Set(["absTol", "relTol", "decimal"]);

function parseOverride(raw: unknown, where: string): CheckOverride {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where}: expected an object`);
  }
  const out: CheckOverride = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!OVERRIDE_KEYS.has(k)) throw new ConfigError(`${where}: unknown option "${k}"`);
    if (k === "decimal") {
      if (v !== "exact" && v !== "numeric") {
        throw new ConfigError(`${where}.decimal: expected "exact" or "numeric"`);
      }
      out.decimal = v;
    } else {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new ConfigError(`${where}.${k}: expected a finite number >= 0`);
      }
      if (k === "absTol") out.absTol = v;
      else out.relTol = v;
    }
  }
  return out;
}

/** Validate a parsed config document. Unknown keys are errors, so a typo never silently loosens a check. */
export function parseConfig(raw: unknown): ParityConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config: expected an object");
  }
  const cfg: ParityConfig = { default: {}, checks: {} };
  for (const [k, v] of Object.entries(raw)) {
    if (k === "default") cfg.default = parseOverride(v, "default");
    else if (k === "checks") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        throw new ConfigError("checks: expected an object");
      }
      for (const [name, o] of Object.entries(v))
        cfg.checks[name] = parseOverride(o, `checks.${name}`);
    } else throw new ConfigError(`config: unknown key "${k}"`);
  }
  return cfg;
}

export function loadConfig(path: string): ParityConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`config: cannot read ${path}`);
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`config: ${path} is not valid JSON`);
  }
}

/** The effective options of one check: built-in defaults < config `default` < config `checks[name]`. */
export function optionsFor(config: ParityConfig, check: string): CompareOptions {
  return { ...DEFAULT_OPTIONS, ...config.default, ...config.checks[check] };
}
