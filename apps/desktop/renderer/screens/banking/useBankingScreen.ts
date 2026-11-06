import { useEffect, useRef, useState } from "react";
import { z } from "zod";

export type BankingAction =
  | { readonly type: "status" | "check" | "banks" | "cancelConsent" | "sync" }
  | { readonly type: "beginConsent"; readonly aspsp: string }
  | { readonly type: "completeConsent"; readonly callbackUrl?: string }
  | { readonly type: "forgetSession"; readonly handle: string }
  | { readonly type: "attemptStatus"; readonly key: string };
export type BankingReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };
/** Native bridge owns the file chooser and bank browser. No path or PEM reaches React. */
export interface BankingUiPort {
  invoke(action: BankingAction): Promise<BankingReply>;
  chooseKeyAndConfigure(appId: string): Promise<BankingReply | { readonly cancelled: true }>;
  openBank(url: string): Promise<void>;
}

const attemptSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{32}$/),
  command: z.literal("banking.importAccount"),
});
const sessionSchema = z.object({
  handle: z.string().regex(/^[a-f0-9]{64}$/),
  institution: z.string().min(1).max(64),
  lastSyncAt: z.string().nullable(),
  backoffUntil: z.string().nullable(),
});
const httpsUrl = z.url().refine((value) => value.startsWith("https://"));
const statusSchema = z.object({
  configured: z.boolean(),
  sessions: z.array(sessionSchema).max(32),
  pendingConsent: httpsUrl.nullable().optional(),
  pendingAttempts: z.array(attemptSchema).max(100).optional(),
});
const bankSchema = z.array(z.object({ name: z.string().min(1).max(256) })).max(1000);
const beginSchema = z.object({ url: httpsUrl });
const resultSchema = z.object({
  errors: z.array(z.string()).optional(),
  attempts: z.array(attemptSchema).max(100).optional(),
});
const attemptStatusSchema = z.object({
  status: z.enum(["outcome_unknown", "completed", "not_started", "refused"]),
});
export interface BankingAttemptView {
  readonly key: string;
  readonly status: "outcome_unknown" | "completed" | "not_started" | "refused";
}

export function useBankingScreen(port: BankingUiPort | null, vaultId: string) {
  const generation = useRef(0);
  const [configured, setConfigured] = useState(false);
  const [connected, setConnected] = useState<z.infer<typeof sessionSchema>[]>([]);
  const [institutions, setInstitutions] = useState<string[]>([]);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [attemptList, setAttempts] = useState<BankingAttemptView[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"error" | "refreshed" | "unknown" | null>(null);
  const current = (ticket: number) => generation.current === ticket;
  const refresh = async (ticket = generation.current) => {
    if (!port) return;
    let reply: BankingReply;
    try {
      reply = await port.invoke({ type: "status" });
    } catch {
      if (current(ticket)) setNotice("error");
      return;
    }
    if (!current(ticket)) return;
    const parsed = reply.ok ? statusSchema.safeParse(reply.value) : null;
    if (!parsed?.success) {
      setNotice("error");
      return;
    }
    setConfigured(parsed.data.configured);
    setConnected(parsed.data.sessions);
    setPendingUrl(parsed.data.pendingConsent ?? null);
    setAttempts((old) => {
      const unknown = (parsed.data.pendingAttempts ?? []).map((item) => ({
        key: item.key,
        status: "outcome_unknown" as const,
      }));
      return [...unknown, ...old.filter((item) => item.status !== "outcome_unknown")];
    });
  };
  useEffect(() => {
    const ticket = ++generation.current;
    if (port) {
      void port
        .invoke({ type: "status" })
        .then((reply) => {
          if (generation.current !== ticket) return;
          const parsed = reply.ok ? statusSchema.safeParse(reply.value) : null;
          if (!parsed?.success) {
            setNotice("error");
            return;
          }
          setConfigured(parsed.data.configured);
          setConnected(parsed.data.sessions);
          setPendingUrl(parsed.data.pendingConsent ?? null);
          setAttempts(
            (parsed.data.pendingAttempts ?? []).map((item) => ({
              key: item.key,
              status: "outcome_unknown",
            })),
          );
        })
        .catch(() => {
          if (generation.current === ticket) setNotice("error");
        });
    }
    return () => {
      generation.current = ticket + 1;
    };
    // Vault and bridge identity define the owner authority.
  }, [port, vaultId]);
  const invoke = (action: BankingAction): Promise<BankingReply> =>
    port ? port.invoke(action) : Promise.resolve({ ok: false, error: "unavailable" });
  const perform = async (
    task: () => Promise<BankingReply | { readonly cancelled: true }>,
    onSuccess?: (value: unknown, ticket: number) => Promise<void> | void,
    mutating = false,
  ) => {
    if (!port || busy) return;
    const ticket = generation.current;
    setBusy(true);
    setNotice(null);
    try {
      const reply = await task();
      if (!current(ticket) || "cancelled" in reply) return;
      if (!reply.ok) {
        setNotice(reply.error === "outcome_unknown" ? "unknown" : "error");
        return;
      }
      await onSuccess?.(reply.value, ticket);
    } catch {
      if (current(ticket)) setNotice(mutating ? "unknown" : "error");
    } finally {
      if (current(ticket)) setBusy(false);
    }
  };
  const applyResult = (value: unknown, ticket: number) => {
    const parsed = resultSchema.safeParse(value);
    if (!parsed.success) throw new Error("invalid banking result");
    if (!current(ticket)) return;
    const unknown = (parsed.data.attempts ?? []).map((item) => ({
      key: item.key,
      status: "outcome_unknown" as const,
    }));
    setAttempts(unknown);
    setNotice(unknown.length ? "unknown" : parsed.data.errors?.length ? "error" : "refreshed");
  };
  return {
    configured,
    connected,
    institutions,
    pendingUrl,
    attemptList,
    busy,
    notice,
    configure: (appId: string) =>
      perform(
        () =>
          port ? port.chooseKeyAndConfigure(appId) : Promise.resolve({ cancelled: true as const }),
        async (value, ticket) => {
          if (!z.object({ configured: z.literal(true) }).safeParse(value).success)
            throw new Error("invalid configuration result");
          await refresh(ticket);
          if (current(ticket)) setNotice("refreshed");
        },
        true,
      ),
    check: () =>
      perform(
        () => invoke({ type: "check" }),
        (value, ticket) => {
          if (
            !z
              .object({
                ok: z.literal(true),
                application: z.object({ name: z.string().nullable() }),
              })
              .safeParse(value).success
          )
            throw new Error("invalid application result");
          if (current(ticket)) setNotice("refreshed");
        },
      ),
    loadBanks: () =>
      perform(
        () => invoke({ type: "banks" }),
        (value, ticket) => {
          const parsed = bankSchema.safeParse(value);
          if (!parsed.success) throw new Error("invalid banks result");
          if (current(ticket)) setInstitutions(parsed.data.map((item) => item.name));
        },
      ),
    begin: (aspsp: string) =>
      perform(
        () => invoke({ type: "beginConsent", aspsp }),
        (value, ticket) => {
          const parsed = beginSchema.safeParse(value);
          if (!parsed.success) throw new Error("invalid consent result");
          if (current(ticket)) setPendingUrl(parsed.data.url);
        },
        true,
      ),
    open: async () => {
      if (port && pendingUrl) await port.openBank(pendingUrl);
    },
    cancel: () =>
      perform(
        () => invoke({ type: "cancelConsent" }),
        async (value, ticket) => {
          if (!z.object({ cancelled: z.literal(true) }).safeParse(value).success)
            throw new Error("invalid cancel result");
          await refresh(ticket);
        },
        true,
      ),
    complete: (callbackUrl: string) =>
      perform(
        () => invoke({ type: "completeConsent", ...(callbackUrl ? { callbackUrl } : {}) }),
        async (value, ticket) => {
          await refresh(ticket);
          applyResult(value, ticket);
        },
        true,
      ),
    sync: () =>
      perform(
        () => invoke({ type: "sync" }),
        async (value, ticket) => {
          await refresh(ticket);
          applyResult(value, ticket);
        },
        true,
      ),
    forget: (handle: string) =>
      perform(
        () => invoke({ type: "forgetSession", handle }),
        async (value, ticket) => {
          if (!z.object({ forgotten: z.literal(true) }).safeParse(value).success)
            throw new Error("invalid forget result");
          await refresh(ticket);
        },
        true,
      ),
    checkAttempt: (key: string) =>
      perform(
        () => invoke({ type: "attemptStatus", key }),
        (value, ticket) => {
          const parsed = attemptStatusSchema.safeParse(value);
          if (!parsed.success) throw new Error("invalid attempt result");
          if (current(ticket))
            setAttempts((old) =>
              old.map((item) =>
                item.key === key ? { ...item, status: parsed.data.status } : item,
              ),
            );
        },
      ),
  };
}
