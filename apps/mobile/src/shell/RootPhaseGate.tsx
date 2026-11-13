// The root's phase (services/lifecycle.ts) around the app: the app's tree under the epoch's key while
// ready (a wipe's rebuild remounts it, so every cache and screen state starts over and the navigator
// starts at its first route, the index, which goes to Today), the "Removing" state while a wipe runs
// (the tree is unmounted, so nothing reads a store being closed), and the fatal state after a wipe that
// could not finish safely.
import { Fragment, type ReactNode, useSyncExternalStore } from "react";
import { getEpoch, getRootPhase, subscribeEpoch } from "../services/lifecycle";
import { WipeStateView } from "./WipeStateView";

export function RootPhaseGate({ children }: { children: ReactNode }) {
  const epoch = useSyncExternalStore(subscribeEpoch, getEpoch, getEpoch);
  const phase = useSyncExternalStore(subscribeEpoch, getRootPhase, getRootPhase);
  if (phase !== "ready") return <WipeStateView phase={phase} />;
  return <Fragment key={epoch}>{children}</Fragment>;
}
