// The phone's pairing flow as a pure reducer (no IO, no clock: times arrive in events). The controller
// (`joiner.ts`) and the screen hook dispatch into it; the View switches on `kind`.
//
// scan -> connecting -> code -> receiving -> storing -> role -> firstSync, plus `discard` (this phone
// holds the vault with changes that never reached the Mac: an explicit yes before anything is replaced),
// `failed` (expired, taken, another sync project, offline, ...) and `closed`. Every state before
// `storing` can be cancelled and leaves nothing behind; from `storing` on the pairing is committed (the
// Mac wrote this phone's membership) and only moves forward.

import type { ProfileRole } from "@cashu/domain/core/notifications";

/** Camera permission as last asked: `unknown` before the first answer. */
export type CameraAccess = "unknown" | "granted" | "denied";

/**
 * Why a pairing stopped (value-free). `expired`: the QR or the six digits ran out ("Scan again").
 * `taken`: another device claimed this code first. `other_project`: the QR belongs to another sync
 * project than this build's. `offline`: sync could not be reached. `no_sync`: this build has no sync set
 * up. `refused`: the Mac stopped it (code refused or cancelled there). `unpushed`: changes of this phone
 * appeared after the question. `failed`: anything else.
 */
export type PairFailure =
  | "expired"
  | "taken"
  | "other_project"
  | "offline"
  | "no_sync"
  | "refused"
  | "unpushed"
  | "failed";

export type PairState =
  | {
      readonly kind: "scan";
      readonly input: "camera" | "paste";
      readonly camera: CameraAccess;
      /** This phone's name on the Mac (signed into the hello, so editable only before connecting). */
      readonly name: string;
      /** The last scan or paste was not a cashU code. */
      readonly notACode: boolean;
    }
  | {
      readonly kind: "discard";
      readonly name: string;
      /** The profile whose unsent changes a re-pairing would remove. */
      readonly profile: string;
      readonly qr: string;
    }
  | { readonly kind: "connecting"; readonly name: string }
  | {
      readonly kind: "code";
      readonly name: string;
      /** The six digits to type on the Mac. */
      readonly sas: string;
      /** When the six digits expire (epoch ms). */
      readonly expiresAt: number;
    }
  | { readonly kind: "receiving"; readonly name: string; readonly parts: number }
  | { readonly kind: "storing"; readonly name: string }
  | { readonly kind: "role"; readonly vault: string; readonly role: ProfileRole }
  | { readonly kind: "firstSync"; readonly vault: string }
  | { readonly kind: "failed"; readonly name: string; readonly reason: PairFailure }
  | { readonly kind: "closed" };

export type PairEvent =
  | { readonly type: "camera"; readonly access: "granted" | "denied" }
  | { readonly type: "input"; readonly input: "camera" | "paste" }
  | { readonly type: "name"; readonly name: string }
  | { readonly type: "notACode" }
  | { readonly type: "discardAsked"; readonly profile: string; readonly qr: string }
  | { readonly type: "connecting" }
  | { readonly type: "sas"; readonly sas: string; readonly expiresAt: number }
  | { readonly type: "part" }
  | { readonly type: "storing" }
  | { readonly type: "stored"; readonly vault: string }
  | { readonly type: "role"; readonly role: ProfileRole }
  | { readonly type: "roleSaved" }
  | { readonly type: "failed"; readonly reason: PairFailure }
  | { readonly type: "scanAgain" }
  | { readonly type: "cancel" }
  | { readonly type: "finish" };

/** The first state: the camera, this phone's default name. */
export function initialPairState(name: string): PairState {
  return { kind: "scan", input: "camera", camera: "unknown", name, notACode: false };
}

/** The states before the commit point: each carries the name this phone offered. */
type BeforeCommit = Extract<
  PairState,
  { kind: "scan" | "discard" | "connecting" | "code" | "receiving" | "failed" }
>;

/** States a cancel may leave: nothing durable has been written yet. */
export function isCancellable(state: PairState): state is BeforeCommit {
  switch (state.kind) {
    case "scan":
    case "discard":
    case "connecting":
    case "code":
    case "receiving":
    case "failed":
      return true;
    default:
      return false;
  }
}

export function pairReducer(state: PairState, event: PairEvent): PairState {
  switch (event.type) {
    case "camera":
      if (state.kind !== "scan") return state;
      // A denied camera makes "Paste the code" the way in, not a hidden fallback.
      return {
        ...state,
        camera: event.access,
        input: event.access === "denied" ? "paste" : state.input,
      };
    case "input":
      if (state.kind !== "scan") return state;
      if (event.input === "camera" && state.camera === "denied") return state;
      return { ...state, input: event.input, notACode: false };
    case "name":
      if (state.kind !== "scan") return state;
      return { ...state, name: event.name };
    case "notACode":
      if (state.kind !== "scan") return state;
      return { ...state, notACode: true };
    case "discardAsked":
      if (state.kind !== "scan") return state;
      return { kind: "discard", name: state.name, profile: event.profile, qr: event.qr };
    case "connecting":
      if (state.kind !== "scan" && state.kind !== "discard") return state;
      return { kind: "connecting", name: state.name };
    case "sas":
      if (state.kind !== "connecting") return state;
      return { kind: "code", name: state.name, sas: event.sas, expiresAt: event.expiresAt };
    case "part":
      if (state.kind === "code") return { kind: "receiving", name: state.name, parts: 1 };
      if (state.kind === "receiving") return { ...state, parts: state.parts + 1 };
      return state;
    case "storing":
      if (state.kind !== "code" && state.kind !== "receiving") return state;
      return { kind: "storing", name: state.name };
    case "stored":
      if (state.kind !== "storing") return state;
      return { kind: "role", vault: event.vault, role: "owner" };
    case "role":
      if (state.kind !== "role") return state;
      return { ...state, role: event.role };
    case "roleSaved":
      if (state.kind !== "role") return state;
      return { kind: "firstSync", vault: state.vault };
    case "failed":
      if (state.kind === "storing")
        return { kind: "failed", name: state.name, reason: event.reason };
      // Later states have the vault on the phone: no pairing failure there.
      if (!isCancellable(state) || state.kind === "failed") return state;
      return { kind: "failed", name: state.name, reason: event.reason };
    case "scanAgain":
      if (state.kind !== "failed" && state.kind !== "discard") return state;
      return initialPairState(state.name);
    case "cancel":
      return isCancellable(state) ? { kind: "closed" } : state;
    case "finish":
      return state.kind === "firstSync" ? { kind: "closed" } : state;
    default:
      return state;
  }
}
