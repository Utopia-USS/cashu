import { useConnection, useProfile } from "@cashu/store-react";
import { isIncognito, onIncognitoChange } from "@cashu/ui-logic/core/incognito";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import type { PairingViewState } from "./PairingView.js";
import { pairingBridge } from "./pairingBridge.js";

type Invite = { readonly operationId: string; readonly qr: string; readonly expiresAt: number };
type Phase =
  | "idle"
  | "creating"
  | "invited"
  | "checking"
  | "unknown"
  | "completed"
  | "refused"
  | "expired";

export function usePairingScreen(): PairingViewState {
  const vault = useProfile();
  const connection = useConnection();
  const privacy = useSyncExternalStore(onIncognitoChange, isIncognito);
  const bridge = pairingBridge();
  const [scope, setScope] = useState({ vault, bridge, connection, privacy });
  const active =
    scope.vault === vault &&
    scope.bridge === bridge &&
    scope.connection === connection &&
    scope.privacy === privacy;
  const [phase, setPhase] = useState<Phase>("idle");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const epoch = useRef(0);
  const busy = useRef(false);
  const currentAttempt = useRef<{ vault: string; operationId: string } | null>(null);
  const inviteRef = useRef<Invite | null>(null);
  const inspectOnScope = useEffectEvent(() => {
    void inspectCurrent();
  });
  const expireOnTimer = useEffectEvent((value: Invite) => {
    void expireInvite(value);
  });

  if (!active) {
    setScope({ vault, bridge, connection, privacy });
    setPhase("idle");
    setInvite(null);
    setCode("");
    setSubmitting(false);
  }

  useEffect(() => {
    ++epoch.current;
    const lifetimeRef = epoch;
    busy.current = false;
    if (currentAttempt.current?.vault !== vault) currentAttempt.current = null;
    if (inviteRef.current && currentAttempt.current?.operationId !== inviteRef.current.operationId)
      inviteRef.current = null;
    if (bridge && !privacy && currentAttempt.current?.vault === vault) inspectOnScope();
    return () => {
      lifetimeRef.current++;
      const pending = inviteRef.current;
      if (pending && bridge && !busy.current)
        void bridge.cancel({ vault, operationId: pending.operationId }).catch(() => {});
    };
  }, [vault, bridge, privacy, connection]);

  useEffect(() => {
    if (!invite || phase !== "invited") return;
    const remaining = invite.expiresAt - Date.now();
    if (remaining <= 0) {
      expireOnTimer(invite);
      return;
    }
    const timeout = setTimeout(() => {
      expireOnTimer(invite);
    }, remaining);
    return () => clearTimeout(timeout);
  }, [invite, phase]);

  async function expireInvite(expired: Invite): Promise<void> {
    if (!bridge || inviteRef.current?.operationId !== expired.operationId) return;
    setInvite(null);
    setCode("");
    setPhase("checking");
    const generation = epoch.current;
    try {
      const result = await bridge.cancel({ vault, operationId: expired.operationId });
      if (generation !== epoch.current) return;
      if (result.kind === "cancelled") {
        currentAttempt.current = null;
        inviteRef.current = null;
        setPhase("expired");
      } else setPhase("unknown");
    } catch {
      if (generation === epoch.current) setPhase("unknown");
    }
  }

  async function inspectCurrent(): Promise<void> {
    const attempt = currentAttempt.current;
    if (!bridge || !attempt || attempt.vault !== vault || busy.current) return;
    busy.current = true;
    const generation = epoch.current;
    setPhase("checking");
    try {
      const result = await bridge.inspect({ vault, operationId: attempt.operationId });
      if (generation !== epoch.current) return;
      if (result.kind === "completed") {
        currentAttempt.current = null;
        setInvite(null);
        inviteRef.current = null;
        setPhase("completed");
      } else if (result.kind === "not_started") {
        currentAttempt.current = null;
        setInvite(null);
        inviteRef.current = null;
        setPhase("refused");
      } else {
        setPhase("unknown");
      }
    } catch {
      if (generation === epoch.current) setPhase("unknown");
    } finally {
      busy.current = false;
    }
  }

  async function create(): Promise<void> {
    if (
      !bridge ||
      busy.current ||
      currentAttempt.current ||
      privacy ||
      (connection !== "online" && connection !== "recovered")
    )
      return;
    busy.current = true;
    const generation = epoch.current;
    setPhase("creating");
    setCode("");
    try {
      const result = await bridge.invite({ vault });
      if (generation !== epoch.current) {
        if (result.kind === "ready")
          void bridge.cancel({ vault, operationId: result.operationId }).catch(() => {});
        return;
      }
      if (result.kind === "ready") {
        currentAttempt.current = { vault, operationId: result.operationId };
        setInvite(result);
        inviteRef.current = result;
        setPhase("invited");
      } else setPhase("refused");
    } catch {
      if (generation === epoch.current) setPhase("refused");
    } finally {
      busy.current = false;
    }
  }

  async function confirm(): Promise<void> {
    const current = invite;
    if (!bridge || !current || busy.current || !/^[0-9]{6}$/.test(code)) return;
    busy.current = true;
    setSubmitting(true);
    const generation = epoch.current;
    const entered = code;
    setCode("");
    setPhase("checking");
    try {
      const result = await bridge.confirm({
        vault,
        operationId: current.operationId,
        code: entered,
      });
      if (generation !== epoch.current) return;
      if (result.kind === "completed") {
        currentAttempt.current = null;
        setInvite(null);
        inviteRef.current = null;
        setPhase("completed");
      } else if (result.kind === "outcome_unknown") {
        setInvite(null);
        inviteRef.current = null;
        setPhase("unknown");
      } else if (result.code === "invalid" && current.expiresAt > Date.now()) {
        setPhase("invited");
      } else {
        setInvite(null);
        inviteRef.current = null;
        currentAttempt.current = null;
        setPhase("refused");
      }
    } catch {
      if (generation === epoch.current) {
        setInvite(null);
        inviteRef.current = null;
        setPhase("unknown");
      }
    } finally {
      busy.current = false;
      if (generation === epoch.current) setSubmitting(false);
    }
  }

  async function cancel(): Promise<void> {
    const current = invite;
    if (!bridge || !current || busy.current) return;
    busy.current = true;
    const generation = epoch.current;
    setInvite(null);
    setCode("");
    setPhase("checking");
    try {
      const result = await bridge.cancel({ vault, operationId: current.operationId });
      if (generation !== epoch.current) return;
      if (result.kind === "cancelled") {
        currentAttempt.current = null;
        inviteRef.current = null;
        setPhase("idle");
      } else {
        inviteRef.current = null;
        setPhase("unknown");
      }
    } catch {
      if (generation === epoch.current) {
        inviteRef.current = null;
        setPhase("unknown");
      }
    } finally {
      busy.current = false;
    }
  }

  if (!active || !bridge || privacy || (connection !== "online" && connection !== "recovered"))
    return { kind: "unavailable" };
  if (phase === "invited" && invite)
    return {
      kind: "invited",
      qr: invite.qr,
      expiresAt: new Date(invite.expiresAt).toLocaleTimeString(),
      code,
      onCodeChange: setCode,
      onConfirm: confirm,
      onCancel: cancel,
      canCopy: !!navigator.clipboard?.writeText,
      onCopy: () => {
        if (navigator.clipboard?.writeText)
          void navigator.clipboard.writeText(invite.qr).catch(() => {});
      },
      submitting,
    };
  if (phase === "unknown") return { kind: "unknown", onInspect: inspectCurrent };
  if (phase === "creating") return { kind: "creating" };
  if (phase === "checking") return { kind: "checking" };
  if (phase === "completed") return { kind: "completed", onCreate: create };
  if (phase === "refused") return { kind: "refused", onCreate: create };
  if (phase === "expired") return { kind: "expired", onCreate: create };
  return { kind: "idle", onCreate: create };
}
