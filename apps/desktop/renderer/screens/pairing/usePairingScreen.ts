import type { PairingCancelResult, PairingInspectResult } from "@cashu/host-protocol";
import { deviceListState } from "@cashu/store/core/desktop-settings";
import { useConnection, useProfile, useQuery } from "@cashu/store-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
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
  /** The phone is admitted; this Mac has not seen its first sync yet (re-inspected on each push). */
  | "waiting"
  | "refused"
  /** A cancel came too late: the host had already written the phone into the vault. */
  | "already_added"
  | "expired"
  /** The invite was refused because this profile's sync is off (or this build has none). */
  | "sync_off";
type Phone = "unknown" | "waiting" | "connected";

/** The code under the QR as one line: its start and end around an ellipsis (the QR holds it all). */
function codePreview(code: string): string {
  return code.length <= 28 ? code : `${code.slice(0, 18)}…${code.slice(-8)}`;
}

/**
 * Whether the host says a phone connected to a pending invitation. The field is not in the host's
 * inspect yet (`phoneConnected` on the `pending` variant); until it is, the answer is "unknown" and the
 * card shows the six-digit field as before.
 */
function phoneOf(result: PairingInspectResult): Phone {
  if (!("phoneConnected" in result) || typeof result.phoneConnected !== "boolean") return "unknown";
  return result.phoneConnected ? "connected" : "waiting";
}

export function usePairingScreen(): PairingViewState {
  const vault = useProfile();
  const connection = useConnection();
  const bridge = pairingBridge();
  // Only a trigger while an invitation is out or waiting for the phone: the host pushes the device
  // list again after every sync pass and device change, and bumps the list's `pairingRevision` on every
  // pairing transition (a phone connected, an admission settled, the phone's first sync). The client
  // keeps an equal snapshot's identity, so a revision-only change still yields a new object here.
  // Also the end of a "Copied" confirmation. No timer.
  const changed = useQuery(deviceListState, { privacy: false });
  const [scope, setScope] = useState({ vault, bridge, connection });
  const active =
    scope.vault === vault && scope.bridge === bridge && scope.connection === connection;
  const [phase, setPhase] = useState<Phase>("idle");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [phone, setPhone] = useState<Phone>("unknown");
  /** The device list snapshot "Copy code" succeeded on: "Copied" lasts until the next push or action. */
  const [copiedOn, setCopiedOn] = useState<{ readonly on: unknown } | null>(null);
  const epoch = useRef(0);
  const busy = useRef(false);
  /** A cancel (the button, or an expiry) is in flight: "Cancel" in the checking state waits for it. */
  const cancelling = useRef(false);
  const currentAttempt = useRef<{ vault: string; operationId: string } | null>(null);
  const inviteRef = useRef<Invite | null>(null);
  const inspectOnScope = useEffectEvent(() => {
    void inspectCurrent();
  });
  const inspectWhileWaiting = useEffectEvent(() => {
    void inspectCurrent(true);
  });
  const inspectWhileInvited = useEffectEvent(() => {
    void inspectInvite();
  });
  const expireOnTimer = useEffectEvent((value: Invite) => {
    void expireInvite(value);
  });

  if (!active) {
    setScope({ vault, bridge, connection });
    setPhase("idle");
    setInvite(null);
    setCode("");
    setSubmitting(false);
    setPhone("unknown");
    setCopiedOn(null);
  }

  useEffect(() => {
    ++epoch.current;
    const lifetimeRef = epoch;
    busy.current = false;
    if (currentAttempt.current?.vault !== vault) currentAttempt.current = null;
    if (inviteRef.current && currentAttempt.current?.operationId !== inviteRef.current.operationId)
      inviteRef.current = null;
    if (bridge && currentAttempt.current?.vault === vault) inspectOnScope();
    return () => {
      lifetimeRef.current++;
      const pending = inviteRef.current;
      if (pending && bridge && !busy.current)
        void bridge.cancel({ vault, operationId: pending.operationId }).catch(() => {});
    };
  }, [vault, bridge, connection]);

  useEffect(() => {
    if (phase === "waiting" && changed) inspectWhileWaiting();
  }, [phase, changed]);

  // Entering the invitation and each push after it ask whether a phone has connected.
  useEffect(() => {
    if (phase === "invited" && changed) inspectWhileInvited();
  }, [phase, changed]);

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
    setCopiedOn(null);
    setPhase("checking");
    const generation = epoch.current;
    cancelling.current = true;
    try {
      const result = await bridge.cancel({ vault, operationId: expired.operationId });
      if (generation !== epoch.current) return;
      settleCancel(result, "expired");
    } catch {
      if (generation === epoch.current) setPhase("unknown");
    } finally {
      if (generation === epoch.current) cancelling.current = false;
    }
  }

  /**
   * The host's answer to a cancel: `cancelled` ends the attempt in `ended` (nothing kept), a refusal
   * with `already_added` ends it too (the phone is in the vault; undoing it is a removal in the device
   * list), any other refusal leaves the attempt to inspect ("outcome unknown").
   */
  function settleCancel(result: PairingCancelResult, ended: "idle" | "expired"): void {
    inviteRef.current = null;
    if (result.kind === "cancelled") {
      currentAttempt.current = null;
      setPhase(ended);
    } else if (result.code === "already_added") {
      currentAttempt.current = null;
      setPhase("already_added");
    } else setPhase("unknown");
  }

  /** `quiet`: a re-check while waiting for the phone keeps the waiting card instead of "checking". */
  async function inspectCurrent(quiet = false): Promise<void> {
    const attempt = currentAttempt.current;
    if (!bridge || !attempt || attempt.vault !== vault || busy.current) return;
    busy.current = true;
    const generation = epoch.current;
    if (!quiet) setPhase("checking");
    try {
      const result = await bridge.inspect({ vault, operationId: attempt.operationId });
      if (generation !== epoch.current) return;
      applyOutcome(result);
    } catch {
      // A quiet re-check that cannot reach the host keeps waiting: the next push asks again.
      if (generation === epoch.current && !quiet) setPhase("unknown");
    } finally {
      if (generation === epoch.current) busy.current = false;
    }
  }

  function applyOutcome(result: PairingInspectResult): void {
    if (result.kind === "completed") {
      currentAttempt.current = null;
      setInvite(null);
      inviteRef.current = null;
      setPhase("completed");
    } else if (result.kind === "waiting_for_phone") {
      setInvite(null);
      inviteRef.current = null;
      setPhase("waiting");
    } else if (result.kind === "not_started") {
      currentAttempt.current = null;
      setInvite(null);
      inviteRef.current = null;
      setPhase("refused");
    } else {
      setPhase("unknown");
    }
  }

  /**
   * While the invitation is out: has a phone connected? Read-only, so it takes no `busy`; an action
   * started meanwhile owns the outcome, and only a still pending invitation updates the card.
   */
  async function inspectInvite(): Promise<void> {
    const attempt = currentAttempt.current;
    if (!bridge || !attempt || attempt.vault !== vault) return;
    const generation = epoch.current;
    try {
      const result = await bridge.inspect({ vault, operationId: attempt.operationId });
      if (generation !== epoch.current || inviteRef.current?.operationId !== attempt.operationId)
        return;
      if (result.kind === "pending") setPhone(phoneOf(result));
      else if (result.kind !== "refused" && !busy.current) applyOutcome(result);
    } catch {
      // The next push asks again.
    }
  }

  async function create(): Promise<void> {
    if (
      !bridge ||
      busy.current ||
      currentAttempt.current ||
      (connection !== "online" && connection !== "recovered")
    )
      return;
    busy.current = true;
    const generation = epoch.current;
    setPhase("creating");
    setCode("");
    setPhone("unknown");
    setCopiedOn(null);
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
      } else
        setPhase(
          result.code === "relay_off" || result.code === "no_config" ? "sync_off" : "refused",
        );
    } catch {
      if (generation === epoch.current) setPhase("refused");
    } finally {
      if (generation === epoch.current) busy.current = false;
    }
  }

  async function confirm(): Promise<void> {
    const current = invite;
    // No phone connected (the host says so): there is nothing to confirm yet.
    if (!bridge || !current || busy.current || phone === "waiting" || !/^[0-9]{6}$/.test(code))
      return;
    busy.current = true;
    setSubmitting(true);
    setCopiedOn(null);
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
      } else if (result.kind === "waiting_for_phone") {
        // Admitted: keep the attempt so each push re-inspects it until the phone's first sync lands.
        setInvite(null);
        inviteRef.current = null;
        setPhase("waiting");
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
      if (generation === epoch.current) {
        busy.current = false;
        setSubmitting(false);
      }
    }
  }

  async function cancel(): Promise<void> {
    const current = invite;
    if (!bridge || !current || busy.current) return;
    busy.current = true;
    cancelling.current = true;
    const generation = epoch.current;
    setInvite(null);
    setCode("");
    setCopiedOn(null);
    setPhase("checking");
    try {
      const result = await bridge.cancel({ vault, operationId: current.operationId });
      if (generation !== epoch.current) return;
      settleCancel(result, "idle");
    } catch {
      if (generation === epoch.current) {
        inviteRef.current = null;
        setPhase("unknown");
      }
    } finally {
      if (generation === epoch.current) {
        busy.current = false;
        cancelling.current = false;
      }
    }
  }

  /**
   * "Cancel" while checking: the way back from any wait (a confirm the host holds until a phone shows
   * up, an inspect). Drops the in-flight wait and cancels the attempt; a host that refuses the cancel
   * (the code is already with it) leaves the honest "outcome unknown" card. A cancel already in flight
   * is simply awaited.
   */
  async function abandon(): Promise<void> {
    if (cancelling.current) return;
    const attempt = currentAttempt.current;
    const generation = ++epoch.current;
    setInvite(null);
    setCode("");
    setSubmitting(false);
    if (!bridge || !attempt || attempt.vault !== vault) {
      busy.current = false;
      inviteRef.current = null;
      setPhase("idle");
      return;
    }
    busy.current = true;
    cancelling.current = true;
    try {
      const result = await bridge.cancel({ vault, operationId: attempt.operationId });
      if (generation !== epoch.current) return;
      settleCancel(result, "idle");
    } catch {
      if (generation === epoch.current) {
        inviteRef.current = null;
        setPhase("unknown");
      }
    } finally {
      if (generation === epoch.current) {
        busy.current = false;
        cancelling.current = false;
      }
    }
  }

  if (!active || !bridge || (connection !== "online" && connection !== "recovered"))
    return { kind: "unavailable" };
  if (phase === "invited" && invite)
    return {
      kind: "invited",
      qr: invite.qr,
      codePreview: codePreview(invite.qr),
      expiresAt: invite.expiresAt,
      phone,
      code,
      onCodeChange: (next) => {
        setCopiedOn(null);
        setCode(next);
      },
      onConfirm: confirm,
      onCancel: cancel,
      canCopy: !!navigator.clipboard?.writeText,
      copied: copiedOn !== null && copiedOn.on === changed,
      onCopy: () => {
        if (!navigator.clipboard?.writeText) return;
        const generation = epoch.current;
        const copiedFrom = { on: changed };
        void navigator.clipboard.writeText(invite.qr).then(
          () => {
            if (generation === epoch.current && inviteRef.current?.qr === invite.qr)
              setCopiedOn(copiedFrom);
          },
          () => {},
        );
      },
      submitting,
    };
  if (phase === "unknown") return { kind: "unknown", onInspect: () => inspectCurrent() };
  if (phase === "waiting") return { kind: "waiting" };
  if (phase === "creating") return { kind: "creating" };
  if (phase === "checking") return { kind: "checking", onCancel: abandon };
  if (phase === "completed") return { kind: "completed", onCreate: create };
  if (phase === "refused") return { kind: "refused", onCreate: create };
  if (phase === "already_added") return { kind: "already_added", onCreate: create };
  if (phase === "expired") return { kind: "expired", onCreate: create };
  if (phase === "sync_off") return { kind: "sync_off", onCreate: create };
  return { kind: "idle", onCreate: create };
}
