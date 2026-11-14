import { mcpProfile } from "@cashu/store/core";
import { z } from "zod";
import type { BankingOwnerResult } from "../banking/ownerAction.js";
import type { OpenVault } from "../stores.js";
import { M } from "./banking.strings.js";
import type { PortedCommand } from "./tree.js";

type Action = {
  readonly type: "status" | "check" | "banks" | "attemptStatus" | "sync" | "forgetSession";
  readonly country?: string;
  readonly days?: number;
  readonly handle?: string;
  readonly key?: string;
};
export interface BankingCliDeps {
  readonly vaults: ReadonlyMap<string, OpenVault>;
  perform(vault: OpenVault, action: Action, signal: AbortSignal): Promise<BankingOwnerResult>;
}

const statusSchema = z.object({
  configured: z.boolean(),
  sessions: z
    .array(
      z.object({
        handle: z.string().regex(/^[a-f0-9]{64}$/),
        institution: z.string(),
        lastSyncAt: z.string().nullable(),
        backoffUntil: z.string().nullable(),
      }),
    )
    .max(32),
  pendingAttempts: z
    .array(
      z.object({
        key: z.string().regex(/^[a-f0-9]{32}$/),
        command: z.literal("banking.importAccount"),
      }),
    )
    .max(100)
    .optional(),
});
const bankSchema = z
  .array(z.object({ name: z.string(), country: z.string(), institution: z.string().nullable() }))
  .max(1000);
const syncSchema = z.object({
  accounts: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  attempts: z.array(
    z.object({
      key: z.string().regex(/^[a-f0-9]{32}$/),
      command: z.literal("banking.importAccount"),
    }),
  ),
});
const appSchema = z.object({
  ok: z.literal(true),
  application: z.object({ name: z.string().nullable() }),
});
const attemptSchema = z.object({
  status: z.enum(["completed", "outcome_unknown", "not_started", "refused"]),
});

function options(args: readonly string[]): {
  leaf: string;
  profile?: string;
  country: string;
  days: number;
  json: boolean;
  arg?: string;
} | null {
  const [leaf, ...rest] = args;
  if (!leaf) return null;
  let profile: string | undefined;
  let country = "PL";
  let days = 90;
  let json = false;
  let arg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--json") json = true;
    else if (
      token === "--profile" ||
      token === "-p" ||
      token === "--country" ||
      token === "--days"
    ) {
      const value = rest[++i];
      if (!value) return null;
      if (token === "--profile" || token === "-p") {
        if (profile && profile !== value) return null;
        profile = value;
      } else if (token === "--country") country = value;
      else days = Number(value);
    } else if (!token?.startsWith("-") && arg === undefined) arg = token;
    else return null;
  }
  if (!/^[A-Z]{2}$/.test(country) || !Number.isInteger(days) || days < 1 || days > 365) return null;
  return { leaf, ...(profile ? { profile } : {}), country, days, json, ...(arg ? { arg } : {}) };
}

/** Native EB CLI surface. It never prints authorization URLs, raw session ids, keys or PEM paths. */
export function bankingCommands(deps: BankingCliDeps): readonly PortedCommand[] {
  return [
    {
      name: "eb",
      async run(args, io, root) {
        const parsed = options(args);
        if (!parsed) {
          io.stderr(`${io.t.tr(M.usage)}\n`);
          return 2;
        }
        if (["auth", "login", "connect"].includes(parsed.leaf)) {
          io.stderr(`${io.t.tr(M.uiOnly)}\n`);
          return 69;
        }
        if (parsed.leaf === "reprocess") {
          io.stderr(`${io.t.tr(M.unavailable)}\n`);
          return 69;
        }
        const slug = parsed.profile ?? root.profile;
        const matches = [...deps.vaults.values()].filter(
          (vault) =>
            vault.mode === "native" &&
            vault.native.isCurrent() &&
            mcpProfile(vault.store.read.bind(vault.store))?.slug === slug,
        );
        if (!slug || matches.length !== 1 || !matches[0]) {
          io.stderr(`${io.t.tr(M.profile)}\n`);
          return 2;
        }
        const vault = matches[0];
        let action: Action;
        if (["status", "sessions"].includes(parsed.leaf) && !parsed.arg)
          action = { type: "status" };
        else if (parsed.leaf === "check" && !parsed.arg) action = { type: "check" };
        else if (parsed.leaf === "banks" && !parsed.arg)
          action = { type: "banks", country: parsed.country };
        else if (["resync", "sync"].includes(parsed.leaf) && !parsed.arg)
          action = { type: "sync", days: parsed.days };
        else if (parsed.leaf === "forget" && parsed.arg && /^[a-f0-9]{64}$/.test(parsed.arg))
          action = { type: "forgetSession", handle: parsed.arg };
        else if (
          parsed.leaf === "attempt-status" &&
          parsed.arg &&
          /^[a-f0-9]{32}$/.test(parsed.arg)
        )
          action = { type: "attemptStatus", key: parsed.arg };
        else {
          io.stderr(`${io.t.tr(M.usage)}\n`);
          return 2;
        }
        if (io.signal.aborted) return 130;
        let result: BankingOwnerResult;
        try {
          result = await deps.perform(vault, action, io.signal);
        } catch {
          io.stderr(`${io.t.tr(M.unknown)}\n`);
          return 1;
        }
        if (io.signal.aborted) {
          if (action.type === "sync" || action.type === "forgetSession") {
            io.stderr(`${io.t.tr(M.unknown)}\n`);
            return 1;
          }
          return 130;
        }
        if (!result.ok) {
          io.stderr(`${io.t.tr(result.error === "outcome_unknown" ? M.unknown : M.unavailable)}\n`);
          return 1;
        }
        const value = result.value;
        const projected =
          action.type === "status"
            ? statusSchema.safeParse(value)
            : action.type === "banks"
              ? bankSchema.safeParse(value)
              : action.type === "sync"
                ? syncSchema.safeParse(value)
                : action.type === "check"
                  ? appSchema.safeParse(value)
                  : action.type === "attemptStatus"
                    ? attemptSchema.safeParse(value)
                    : z.object({ forgotten: z.literal(true) }).safeParse(value);
        if (!projected.success) {
          io.stderr(`${io.t.tr(M.unknown)}\n`);
          return 1;
        }
        const safe = projected.data;
        io.stdout(
          parsed.json
            ? `${JSON.stringify(safe)}\n`
            : `${typeof safe === "object" ? JSON.stringify(safe) : io.t.tr(M.done)}\n`,
        );
        return 0;
      },
    },
  ];
}
