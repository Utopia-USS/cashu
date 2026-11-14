// The pairing flow's state outside React: it must survive the services' reopen after the vault was added
// (the root remounts its whole tree, the modal included), so the role and first-sync steps continue where
// they were and the shell presents the modal again (`pairingContinues`). One flow per launch; the
// running `PhonePairing` is held here too. Removing this phone resets it (a before-wipe task): the run
// stops and stores nothing more, and no role or first-sync step reopens for a vault the wipe removed.
import { onBeforeWipe } from "../../services/wipe";
import type { PairingPorts } from "./joiner";
import { PhonePairing } from "./joiner";
import {
  type CameraAccess,
  initialPairState,
  type PairEvent,
  type PairState,
  pairReducer,
} from "./pairState";

let state: PairState | undefined;
let running: PhonePairing | undefined;
/** A `start` has not settled yet. */
let busy = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export const pairFlow = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** The flow's state; a fresh scan (with `name`) when none runs. */
  get(name: string): PairState {
    state ??= initialPairState(name);
    return state;
  },
  /** The state as it is (undefined before the first open), for the shell. */
  peek(): PairState | undefined {
    return state;
  },
  dispatch(event: PairEvent): void {
    const current = state;
    if (current === undefined) return;
    const next = pairReducer(current, event);
    if (next === current) return;
    state = next;
    emit();
  },
  /**
   * Run a pairing for a scanned / pasted code. Ignored while one runs (the camera reports the same QR
   * several times before the scan step unmounts).
   */
  start(ports: PairingPorts, qr: string, name: string, discardUnpushed: boolean): void {
    if (busy) return;
    busy = true;
    running?.abandon();
    const pairing = new PhonePairing(ports, (event) => {
      if (running === pairing) pairFlow.dispatch(event);
    });
    running = pairing;
    void pairing.start(qr, name, { discardUnpushed }).finally(() => {
      busy = false;
    });
  },
  /** Cancel (only before storing): the running pairing stops and leaves nothing behind. */
  cancel(): void {
    if (running !== undefined) running.cancel();
    else pairFlow.dispatch({ type: "cancel" });
  },
  /** The six digits ran out: the run stops and the flow says "Scan again". */
  expire(): void {
    running?.abandon();
    running = undefined;
    pairFlow.dispatch({ type: "failed", reason: "expired" });
  },
  /** A new scan after a failure or the discard question, with the camera permission as last answered. */
  scanAgain(camera: CameraAccess): void {
    running?.abandon();
    running = undefined;
    pairFlow.dispatch({ type: "scanAgain", camera });
  },
  /** The flow ended (closed): the next open starts over. */
  reset(): void {
    running?.abandon();
    running = undefined;
    state = undefined;
    emit();
  },
};

// Registered once at module load (outside the services, so it survives their rebuild).
onBeforeWipe(() => {
  running?.discard();
  pairFlow.reset();
});

/** A pairing whose vault is on the phone and whose last steps (role, first sync) still wait. */
export function pairingContinues(): boolean {
  const kind = state?.kind;
  return kind === "role" || kind === "firstSync";
}
