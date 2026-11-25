import { useEffect, useRef, useState } from "react";
import { z } from "zod";

export type BankingAction =
  | {
      readonly type: "status" | "check" | "banks" | "cancelConsent" | "sync" | "unconfigure";
    }
  | { readonly type: "beginConsent"; readonly aspsp: string }
  | { readonly type: "completeConsent"; readonly callbackUrl?: string }
  | { readonly type: "awaitConsent" }
  | { readonly type: "offerCallback"; readonly callbackUrl: string }
  | { readonly type: "forgetSession"; readonly handle: string }
  | { readonly type: "attemptStatus"; readonly key: string };
export type BankingReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };
/**
 * Native bridge owns the file chooser and bank browser. No path or PEM reaches React: a dropped key
 * file goes to the bridge as the File handle, unread.
 */
export interface BankingUiPort {
  invoke(action: BankingAction): Promise<BankingReply>;
  chooseKeyAndConfigure(appId: string): Promise<BankingReply | { readonly cancelled: true }>;
  configureWithDroppedKey(appId: string, file: File): Promise<BankingReply>;
  /** Every attempt of unknown outcome is now resolved: the panel may accept writes again. */
  settled?(): void;
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
  application: z.string().max(128).nullable().optional(),
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
export type BankingNotice =
  | "error"
  | "refreshed"
  | "checked"
  | "importUnknown"
  | "changeUnknown"
  | "previousUnknown"
  | "keyType"
  | "keyUnreadable"
  | "keyInvalid"
  | "configuration"
  | "appIdRequired"
  | "bankRefused"
  | "transport"
  | "rateLimited"
  | "callback"
  | "redirectNotAllowed"
  | "unknownBank"
  | "appRestricted"
  | "consentDenied"
  | "consentTimeout"
  | "callbackInvalid"
  | "openFailed"
  | "removed";
/** Definite refusal codes with a notice of their own; any other refusal is a plain error. */
const NOTICE_BY_ERROR: Readonly<Record<string, BankingNotice>> = {
  app_id_required: "appIdRequired",
  key_file_invalid: "keyType",
  key_unreadable: "keyUnreadable",
  key_invalid: "keyInvalid",
  configuration: "configuration",
  response: "bankRefused",
  expired: "bankRefused",
  transport: "transport",
  rate_limited: "rateLimited",
  callback: "callback",
  redirect_not_allowed: "redirectNotAllowed",
  unknown_bank: "unknownBank",
  app_restricted: "appRestricted",
  consent_denied: "consentDenied",
  consent_timeout: "consentTimeout",
  callback_invalid: "callbackInvalid",
  pending_previous_attempt: "previousUnknown",
};
const PEM_NAME = /\.pem$/i;

export type BankListState = "idle" | "loading" | "ready" | "failed";

/** The bank names Enable Banking lists for the profile's country; null when it cannot be read. */
async function loadBankNames(port: BankingUiPort): Promise<string[] | null> {
  try {
    const reply = await port.invoke({ type: "banks" });
    const parsed = reply.ok ? bankSchema.safeParse(reply.value) : null;
    if (!parsed?.success) return null;
    return [...new Set(parsed.data.map((item) => item.name))].sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
}

export interface BankingAttemptView {
  readonly key: string;
  readonly status: "outcome_unknown" | "completed" | "not_started" | "refused";
}

export function useBankingScreen(port: BankingUiPort | null, vaultId: string) {
  const generation = useRef(0);
  const [configured, setConfigured] = useState(false);
  const [applicationId, setApplicationId] = useState<string | null>(null);
  /** The owner chose to replace the configured application or key: the key form shows again. */
  const [editingKey, setEditingKey] = useState(false);
  const [connected, setConnected] = useState<z.infer<typeof sessionSchema>[]>([]);
  const [institutions, setInstitutions] = useState<string[]>([]);
  const [bankList, setBankList] = useState<BankListState>("idle");
  const [application, setApplication] = useState<string | null>(null);
  /** The owner is at the bank: cashU waits for the bank's answer and finishes by itself. */
  const [waiting, setWaiting] = useState(false);
  /** The bank answered: cashU creates the session and loads the transactions. */
  const [importing, setImporting] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [attemptList, setAttempts] = useState<BankingAttemptView[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<BankingNotice | null>(null);
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
    setApplicationId(parsed.data.application ?? null);
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
          setApplicationId(parsed.data.application ?? null);
          setConnected(parsed.data.sessions);
          setPendingUrl(parsed.data.pendingConsent ?? null);
          setAttempts(
            (parsed.data.pendingAttempts ?? []).map((item) => ({
              key: item.key,
              status: "outcome_unknown",
            })),
          );
          if (!parsed.data.configured) return;
          // The bank picker needs the list: load it once, right after the status, never in parallel.
          setBankList("loading");
          setBusy(true);
          return loadBankNames(port).then((names) => {
            if (generation.current !== ticket) return;
            setBusy(false);
            setInstitutions(names ?? []);
            setBankList(names ? "ready" : "failed");
          });
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
  /**
   * Runs one action. `unknownNotice` is what an action that may have written says when its outcome is
   * unknown; null for an action that writes nothing, whose every failure is a definite error.
   */
  const perform = async (
    task: () => Promise<BankingReply | { readonly cancelled: true }>,
    onSuccess?: (value: unknown, ticket: number) => Promise<void> | void,
    unknownNotice: BankingNotice | null = null,
  ) => {
    if (!port || busy) return;
    const ticket = generation.current;
    setBusy(true);
    setNotice(null);
    try {
      const reply = await task();
      if (!current(ticket) || "cancelled" in reply) return;
      if (!reply.ok) {
        setNotice(
          reply.error === "outcome_unknown"
            ? (unknownNotice ?? "error")
            : (NOTICE_BY_ERROR[reply.error] ?? "error"),
        );
        return;
      }
      await onSuccess?.(reply.value, ticket);
    } catch {
      if (current(ticket)) setNotice(unknownNotice ?? "error");
    } finally {
      if (current(ticket)) setBusy(false);
    }
  };
  const fillBanks = async (ticket: number) => {
    if (!port) return;
    setBankList("loading");
    const names = await loadBankNames(port);
    if (!current(ticket)) return;
    setInstitutions(names ?? []);
    setBankList(names ? "ready" : "failed");
  };
  const afterConfigure = async (value: unknown, ticket: number) => {
    if (!z.object({ configured: z.literal(true) }).safeParse(value).success)
      throw new Error("invalid configuration result");
    await refresh(ticket);
    if (!current(ticket)) return;
    setEditingKey(false);
    setNotice("refreshed");
    await fillBanks(ticket);
  };
  /**
   * Finishes a consent in two calls: the first returns as soon as the bank's answer is in (up to 5
   * minutes, on the host), the second creates the session and runs the first import, which takes a
   * while; between them the screen says the transactions are loading. Neither sets `busy`, so the
   * other buttons stay usable while the owner is at the bank.
   */
  const awaitConsent = async (ticket: number) => {
    if (!port || waiting || importing) return;
    setWaiting(true);
    let answer: BankingReply;
    try {
      answer = await port.invoke({ type: "awaitConsent" });
    } catch {
      answer = { ok: false, error: "error" };
    }
    if (!current(ticket)) return;
    setWaiting(false);
    if (!answer.ok) {
      await refresh(ticket);
      // A cancel by the owner needs no notice; everything else says what happened.
      if (current(ticket) && answer.error !== "consent_cancelled")
        setNotice(NOTICE_BY_ERROR[answer.error] ?? "error");
      return;
    }
    setImporting(true);
    let reply: BankingReply;
    try {
      reply = await port.invoke({ type: "completeConsent" });
    } catch {
      if (!current(ticket)) return;
      setImporting(false);
      setNotice("importUnknown");
      return;
    }
    if (!current(ticket)) return;
    await refresh(ticket);
    if (!current(ticket)) return;
    setImporting(false);
    if (!reply.ok) {
      setNotice(
        reply.error === "outcome_unknown"
          ? "importUnknown"
          : (NOTICE_BY_ERROR[reply.error] ?? "error"),
      );
      return;
    }
    try {
      applyResult(reply.value, ticket);
    } catch {
      setNotice("error");
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
    setNotice(
      unknown.length ? "importUnknown" : parsed.data.errors?.length ? "error" : "refreshed",
    );
  };
  return {
    configured,
    applicationId,
    editingKey,
    editKey: (on: boolean) => setEditingKey(on),
    connected,
    institutions,
    bankList,
    application,
    pendingUrl,
    waiting,
    importing,
    attemptList,
    busy,
    notice,
    configure: (appId: string) =>
      perform(
        () =>
          port ? port.chooseKeyAndConfigure(appId) : Promise.resolve({ cancelled: true as const }),
        afterConfigure,
        "changeUnknown",
      ),
    configureDropped: (appId: string, file: File) => {
      if (!PEM_NAME.test(file.name)) {
        setNotice("keyType");
        return Promise.resolve();
      }
      return perform(
        () =>
          port
            ? port.configureWithDroppedKey(appId, file)
            : Promise.resolve({ cancelled: true as const }),
        afterConfigure,
        "changeUnknown",
      );
    },
    check: () =>
      perform(
        () => invoke({ type: "check" }),
        (value, ticket) => {
          const parsed = z
            .object({
              ok: z.literal(true),
              application: z.object({ name: z.string().nullable() }),
            })
            .safeParse(value);
          if (!parsed.success) throw new Error("invalid application result");
          if (!current(ticket)) return;
          setApplication(parsed.data.application.name);
          setNotice("checked");
        },
      ),
    unconfigure: () =>
      perform(
        () => invoke({ type: "unconfigure" }),
        async (value, ticket) => {
          if (!z.object({ removed: z.literal(true) }).safeParse(value).success)
            throw new Error("invalid remove result");
          await refresh(ticket);
          if (!current(ticket)) return;
          setInstitutions([]);
          setBankList("idle");
          setApplication(null);
          setNotice("removed");
        },
        "changeUnknown",
      ),
    loadBanks: () =>
      perform(
        async () => ({ ok: true, value: null }),
        (_value, ticket) => fillBanks(ticket),
      ),
    begin: (aspsp: string) =>
      perform(
        () => invoke({ type: "beginConsent", aspsp }),
        (value, ticket) => {
          const parsed = beginSchema.safeParse(value);
          if (!parsed.success) throw new Error("invalid consent result");
          if (!current(ticket)) return;
          setPendingUrl(parsed.data.url);
          void awaitConsent(ticket);
        },
      ),
    open: async () => {
      if (!port || !pendingUrl) return;
      // After a reopened Settings nobody may be waiting yet: start before the browser opens.
      const ticket = generation.current;
      void awaitConsent(ticket);
      try {
        await port.openBank(pendingUrl);
      } catch {
        if (current(ticket)) setNotice("openFailed");
      }
    },
    offer: (callbackUrl: string) =>
      perform(
        () => invoke({ type: "offerCallback", callbackUrl }),
        (_value, ticket) => {
          if (current(ticket)) void awaitConsent(ticket);
        },
      ),
    cancel: () =>
      perform(
        () => invoke({ type: "cancelConsent" }),
        async (value, ticket) => {
          if (!z.object({ cancelled: z.literal(true) }).safeParse(value).success)
            throw new Error("invalid cancel result");
          await refresh(ticket);
        },
      ),
    sync: () =>
      perform(
        () => invoke({ type: "sync" }),
        async (value, ticket) => {
          await refresh(ticket);
          applyResult(value, ticket);
        },
        "importUnknown",
      ),
    forget: (handle: string) =>
      perform(
        () => invoke({ type: "forgetSession", handle }),
        async (value, ticket) => {
          if (!z.object({ forgotten: z.literal(true) }).safeParse(value).success)
            throw new Error("invalid forget result");
          await refresh(ticket);
        },
        "changeUnknown",
      ),
    checkAttempt: (key: string) =>
      perform(
        () => invoke({ type: "attemptStatus", key }),
        (value, ticket) => {
          const parsed = attemptStatusSchema.safeParse(value);
          if (!parsed.success) throw new Error("invalid attempt result");
          if (!current(ticket)) return;
          setAttempts((old) =>
            old.map((item) => (item.key === key ? { ...item, status: parsed.data.status } : item)),
          );
          const stillUnknown = attemptList.some(
            (item) => item.key !== key && item.status === "outcome_unknown",
          );
          if (parsed.data.status !== "outcome_unknown" && !stillUnknown) port?.settled?.();
        },
      ),
  };
}
