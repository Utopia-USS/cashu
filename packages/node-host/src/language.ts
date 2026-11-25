// The Node side of the backend language choice (`@cashu/i18n` `BackendLanguageSource`, shaped
// structurally so this package needs no i18n import), as Python's `core/i18n.py` reads it:
// `CASHU_LANG`, then the `language` field of `<data dir>/settings.json`, then the OS (macOS
// `AppleLanguages` first: a launchd agent has no LANG; then LC_ALL / LC_MESSAGES / LANG). The values
// are untrusted (`parseLang` validates them). The shim and the host's CLI runner only read it; the
// dashboard remembers the language (`rememberLanguage` is a no-op here).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface NodeLanguageSource {
  environmentLanguage(): unknown;
  storedLanguage(): unknown;
  osLanguage(): unknown;
  rememberLanguage(language: string): void;
}

export interface NodeLanguageOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The data dir holding settings.json (undefined: no stored choice). */
  readonly dataDir: string | undefined;
  readonly platform?: NodeJS.Platform;
  /** Tests: the `defaults read -g AppleLanguages` output. */
  readonly appleLanguages?: () => string;
}

const PL_OR_EN = /^(pl|en)(?:[-_.]|$)/i;

function readAppleLanguages(): string {
  const r = spawnSync("defaults", ["read", "-g", "AppleLanguages"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return typeof r.stdout === "string" ? r.stdout : "";
}

export function nodeLanguageSource(options: NodeLanguageOptions): NodeLanguageSource {
  const platform = options.platform ?? process.platform;
  let os: unknown;
  let osRead = false;
  return {
    environmentLanguage: () => options.env.CASHU_LANG ?? null,
    storedLanguage() {
      if (options.dataDir === undefined) return null;
      try {
        const data: unknown = JSON.parse(
          readFileSync(join(options.dataDir, "settings.json"), "utf8"),
        );
        return typeof data === "object" && data !== null && !Array.isArray(data)
          ? ((data as Record<string, unknown>).language ?? null)
          : null;
      } catch {
        return null;
      }
    },
    osLanguage() {
      if (osRead) return os;
      osRead = true;
      os = null;
      if (platform === "darwin") {
        let out = "";
        try {
          out = (options.appleLanguages ?? readAppleLanguages)();
        } catch {
          out = "";
        }
        for (const token of out.replace(/[(),]/g, " ").split(/\s+/)) {
          const tag = token.replace(/^"+|"+$/g, "");
          if (PL_OR_EN.test(tag)) {
            os = tag;
            return os;
          }
        }
      }
      for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
        const value = options.env[key];
        if (value) {
          os = value;
          return os;
        }
      }
      return os;
    },
    rememberLanguage() {},
  };
}
