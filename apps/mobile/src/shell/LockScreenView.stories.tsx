// Stories of the lock screen (CSF 3, synthetic profile): locked, the last check failed, nothing set up
// to check with, and before a profile is known. The lock gate test renders every story.
import { LockScreenView, type LockScreenViewProps } from "./LockScreenView";

const base: LockScreenViewProps = {
  initial: "A",
  failure: null,
  onUnlock: async () => {},
};

const meta = { title: "Mobile/Shell/LockScreen", component: LockScreenView, args: base };
export default meta;

export const Locked = { args: {} };
export const Failed = { args: { failure: "failed" } };
export const Unavailable = { args: { failure: "unavailable" } };
export const NoProfile = { args: { initial: null } };
