// The pairing modal's screen hook: the flow (`pairFlow`, which outlives the services' reopen), the
// camera permission, the pasted text, the six digits' countdown and the first sync's progress of the
// vault just added. Navigation and the services-facing ports come in from the route.
import type { ProfileRole } from "@cashu/domain/core/notifications";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { useCameraAccess } from "../../platform/camera";
import { useVaultSyncStatus } from "../../sync/usePhoneSync";
import type { PairingPorts } from "./joiner";
import { pairFlow } from "./pairFlow";
import type { CameraAccess, PairFailure } from "./pairState";

export type PairScreenState =
  | {
      readonly kind: "scan";
      readonly input: "camera" | "paste";
      readonly camera: CameraAccess;
      readonly name: string;
      readonly notACode: boolean;
      readonly pasted: string;
      onScanned(text: string): void;
      onPastedChanged(text: string): void;
      onPasteSubmitted(): void;
      onUsePaste(): void;
      onUseCamera(): void;
      onNameChanged(name: string): void;
      onCancel(): void;
    }
  | {
      readonly kind: "discard";
      readonly profile: string;
      onDiscard(): void;
      onCancel(): void;
    }
  | { readonly kind: "connecting"; onCancel(): void }
  | {
      readonly kind: "code";
      readonly sas: string;
      readonly name: string;
      /** Whole seconds left of the six digits. */
      readonly secondsLeft: number;
      onCancel(): void;
    }
  | { readonly kind: "receiving"; readonly parts: number; onCancel(): void }
  | { readonly kind: "storing" }
  /** The flow ended; the route is leaving. */
  | { readonly kind: "closed" }
  | {
      readonly kind: "role";
      readonly role: ProfileRole;
      onRolePicked(role: ProfileRole): void;
      onContinue(): void;
    }
  | {
      readonly kind: "firstSync";
      /** The profile's name once it arrived. */
      readonly profile: string | null;
      /** Events applied of the estimate (the first sync's progress), when known. */
      readonly progress: { readonly applied: number; readonly expected: number } | null;
      /** The profile and its accounts are here: "Open cashU" works. */
      readonly canOpen: boolean;
      /** Everything arrived. */
      readonly done: boolean;
      onOpen(): void;
    }
  | {
      readonly kind: "failed";
      readonly reason: PairFailure;
      onScanAgain(): void;
      onCancel(): void;
    };

export interface PairScreenArgs {
  /** The default device name (the model). */
  readonly defaultName: string;
  /** The ports over the running services (built on each start). */
  ports(): PairingPorts;
  /** Leave the modal. */
  close(): void;
  /** Store the role for the vault (reopens the services when it changed). */
  saveRole(vault: string, role: ProfileRole): Promise<void>;
  /** The profile names this phone holds now (the first sync's title). */
  profileName(vault: string): string | null;
  readonly now?: () => number;
}

export function usePairScreen(args: PairScreenArgs): PairScreenState {
  const read = () => pairFlow.get(args.defaultName);
  const state = useSyncExternalStore(pairFlow.subscribe, read, read);
  const [pasted, setPasted] = useState("");
  const now = args.now ?? Date.now;
  const [clock, setClock] = useState(now);
  const vault = state.kind === "firstSync" ? state.vault : "";
  const status = useVaultSyncStatus(vault);

  useCameraAccess((access) => {
    if (state.kind === "scan" && state.camera !== access) {
      pairFlow.dispatch({ type: "camera", access });
    }
  });

  // The six digits' countdown; at zero the run stops and the flow says "Scan again".
  const tick = useEffectEvent(() => {
    const at = now();
    setClock(at);
    if (state.kind === "code" && at >= state.expiresAt) pairFlow.expire();
  });
  const counting = state.kind === "code";
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [counting]);

  // The flow closed (cancel, "Open cashU"): leave and start over next time.
  const leave = useEffectEvent(() => {
    pairFlow.reset();
    args.close();
  });
  const closed = state.kind === "closed";
  useEffect(() => {
    if (closed) leave();
  }, [closed]);

  const start = (qr: string, discard: boolean, name: string) =>
    pairFlow.start(args.ports(), qr, name, discard);
  const cancel = () => pairFlow.cancel();

  switch (state.kind) {
    case "scan":
      return {
        kind: "scan",
        input: state.input,
        camera: state.camera,
        name: state.name,
        notACode: state.notACode,
        pasted,
        onScanned: (text) => start(text, false, state.name.trim() || args.defaultName),
        onPastedChanged: setPasted,
        onPasteSubmitted: () => start(pasted, false, state.name.trim() || args.defaultName),
        onUsePaste: () => pairFlow.dispatch({ type: "input", input: "paste" }),
        onUseCamera: () => pairFlow.dispatch({ type: "input", input: "camera" }),
        onNameChanged: (name) => pairFlow.dispatch({ type: "name", name }),
        onCancel: cancel,
      };
    case "discard":
      return {
        kind: "discard",
        profile: state.profile,
        onDiscard: () => start(state.qr, true, state.name),
        onCancel: cancel,
      };
    case "connecting":
      return { kind: "connecting", onCancel: cancel };
    case "code":
      return {
        kind: "code",
        sas: state.sas,
        name: state.name,
        secondsLeft: Math.max(0, Math.ceil((state.expiresAt - Math.max(clock, now())) / 1000)),
        onCancel: cancel,
      };
    case "receiving":
      return { kind: "receiving", parts: state.parts, onCancel: cancel };
    case "storing":
      return { kind: "storing" };
    case "role":
      return {
        kind: "role",
        role: state.role,
        onRolePicked: (role) => pairFlow.dispatch({ type: "role", role }),
        onContinue: () => {
          const { vault: picked, role } = state;
          // The flow moves on first: a changed role reopens the services (the modal remounts).
          pairFlow.dispatch({ type: "roleSaved" });
          void args.saveRole(picked, role).catch(() => {
            // The role stays "mine"; the profile sheet changes it later.
          });
        },
      };
    case "firstSync": {
      const ready = status?.phase === "ready";
      return {
        kind: "firstSync",
        profile: ready ? args.profileName(state.vault) : null,
        progress: status?.progress ?? null,
        canOpen: ready,
        done: ready && status?.syncing !== true,
        onOpen: () => pairFlow.dispatch({ type: "finish" }),
      };
    }
    case "failed":
      return {
        kind: "failed",
        reason: state.reason,
        onScanAgain: () => {
          setPasted("");
          pairFlow.scanAgain();
        },
        onCancel: cancel,
      };
    case "closed":
      return { kind: "closed" };
  }
}
