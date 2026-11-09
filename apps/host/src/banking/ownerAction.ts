import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { BankingFault } from "./client.js";
import type { BankingRuntime } from "./runtime.js";
import { isBankingRsaKey } from "./service.js";

const command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }),
  z.object({
    type: z.literal("configure"),
    appId: z.string().min(1).max(128),
    keyFilePath: z.string().min(1).max(4096),
  }),
  z.object({ type: z.literal("check") }),
  z.object({
    type: z.literal("banks"),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .default("PL"),
  }),
  z.object({
    type: z.literal("beginConsent"),
    aspsp: z.string().min(1).max(256),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .default("PL"),
    days: z.number().int().min(1).max(90).default(90),
    bank: z
      .string()
      .regex(/^[a-z0-9_-]+$/)
      .nullable()
      .optional(),
    keepOthers: z.boolean().default(false),
  }),
  z.object({ type: z.literal("completeConsent"), callbackUrl: z.string().max(4096).optional() }),
  z.object({ type: z.literal("offerCallback"), callbackUrl: z.string().min(1).max(4096) }),
  z.object({ type: z.literal("cancelConsent") }),
  z.object({ type: z.literal("sync"), days: z.number().int().min(1).max(365).default(90) }),
  z.object({ type: z.literal("forgetSession"), handle: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ type: z.literal("attemptStatus"), key: z.string().regex(/^[a-f0-9]{32}$/) }),
]);

/**
 * The owner's chooser or drop passes a path; only the owner host reads this regular PEM file. Its
 * permission bits are not checked: Enable Banking's Control Panel hands the key over as a browser
 * download (0644), and its contents go into the vault's secret store, not used from the file.
 */
async function readPrivateBankingKey(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new BankingFault("configuration");
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new BankingFault("configuration");
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > 64 * 1024 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new BankingFault("configuration");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    try {
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      if (used === bytes.length) throw new BankingFault("configuration");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    } catch {
      throw new BankingFault("configuration");
    } finally {
      bytes.fill(0);
    }
  } finally {
    await file.close();
  }
}

/**
 * Faults that end a mutating action before it changed anything: a bad key or setting, or a consent
 * that never produced a code (denied, timed out, cancelled, a wrong copied URL). They are definite.
 */
const DEFINITE_FAULTS: ReadonlySet<string> = new Set([
  "configuration",
  "consent_denied",
  "consent_timeout",
  "consent_cancelled",
  "callback_invalid",
]);

/**
 * One stderr line per refused owner action (the detached host sends stderr to host.log): the action
 * type and a static code only, never a bank name, URL, path or response text.
 */
function logRefusal(action: string, code: string): void {
  try {
    console.warn("banking.refused", action, code);
  } catch {
    // Best effort: a broken stderr must not change the refusal.
  }
}

export type BankingOwnerResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/** Exact owner UI boundary. Unknown commands and every failure return static codes only. */
export async function runBankingOwnerAction(input: {
  readonly runtime: BankingRuntime;
  readonly profileId: string;
  readonly isOwnerAction: (profileId: string) => boolean;
  readonly action: unknown;
}): Promise<BankingOwnerResult> {
  if (!input.isOwnerAction(input.profileId)) return { ok: false, error: "authorization" };
  const parsed = command.safeParse(input.action);
  if (!parsed.success) return { ok: false, error: "unknown_or_invalid_action" };
  const service = input.runtime.service(input.profileId);
  if (!service) return { ok: false, error: "profile_unavailable" };
  try {
    const action = parsed.data;
    switch (action.type) {
      case "status":
        return { ok: true, value: await service.status() };
      case "configure": {
        // Both checks run before anything is stored, so their refusals are definite.
        let privateKeyPem: string;
        try {
          privateKeyPem = await readPrivateBankingKey(action.keyFilePath);
        } catch {
          logRefusal("configure", "key_unreadable");
          return { ok: false, error: "key_unreadable" };
        }
        if (!isBankingRsaKey(privateKeyPem)) {
          logRefusal("configure", "key_invalid");
          return { ok: false, error: "key_invalid" };
        }
        return {
          ok: true,
          value: await service.configure({ appId: action.appId, privateKeyPem }),
        };
      }
      case "check":
        return { ok: true, value: await service.check() };
      case "banks":
        return { ok: true, value: await service.banks(action.country) };
      case "beginConsent":
        return { ok: true, value: await service.beginConsent(action) };
      case "completeConsent":
        return { ok: true, value: await service.completeConsent(action.callbackUrl) };
      case "offerCallback":
        return { ok: true, value: service.offerCallback(action.callbackUrl) };
      case "cancelConsent":
        await service.cancelConsent();
        return { ok: true, value: { cancelled: true } };
      case "sync":
        return { ok: true, value: await service.sync({ reason: "manual", days: action.days }) };
      case "forgetSession":
        await service.forgetSession(action.handle);
        return { ok: true, value: { forgotten: true } };
      case "attemptStatus":
        return { ok: true, value: { status: service.attemptStatus(action.key) } };
    }
  } catch (error) {
    // beginConsent and cancelConsent are not here: they store nothing (the pending consent lives in
    // memory, kept only after /auth gave a usable URL), so each of their refusals is definite and the
    // owner can simply retry.
    const mutating = ["configure", "completeConsent", "sync", "forgetSession"].includes(
      parsed.data.type,
    );
    const code =
      mutating && !(error instanceof BankingFault && DEFINITE_FAULTS.has(error.kind))
        ? "outcome_unknown"
        : error instanceof BankingFault
          ? error.kind
          : "unavailable";
    logRefusal(parsed.data.type, code);
    return { ok: false, error: code };
  }
}
