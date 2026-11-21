// While a vault's first sync runs (the snapshot import or the replay of the whole history, whose parts
// each notify), the phone's live queries do not re-run per applied part: the client's re-runs are held
// and run once when the first sync ends (the pass that ends it stops `syncing`). Every other pass, and
// every command, re-runs the woken queries once after it (`createRerunScheduler`).
import type { RerunScheduler } from "@cashu/store-react/local";
import type { VaultSession, VaultSyncStatus } from "./vaultEngine";

/** A pass of a vault whose profile has not arrived yet (its first sync), or one counting its progress. */
function firstSyncRunning(status: VaultSyncStatus): boolean {
  return status.syncing && (status.phase === "receiving" || status.progress !== undefined);
}

/** Hold `reruns` while any of `sessions` runs its first sync; returns the unsubscribe. */
export function holdRerunsDuringFirstSync(
  reruns: RerunScheduler,
  sessions: readonly Pick<VaultSession, "status" | "subscribe">[],
): () => void {
  let release: (() => void) | undefined;
  const update = () => {
    const running = sessions.some((s) => firstSyncRunning(s.status()));
    if (running && release === undefined) release = reruns.hold();
    else if (!running && release !== undefined) {
      const done = release;
      release = undefined;
      done();
    }
  };
  const stops = sessions.map((s) => s.subscribe(update));
  update();
  return () => {
    for (const stop of stops) stop();
    release?.();
    release = undefined;
  };
}
