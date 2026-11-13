// Stories of the root's wipe states (CSF 3): removing, and the fatal state. The root phase test renders
// every story.
import { WipeStateView, type WipeStateViewProps } from "./WipeStateView";

const base: WipeStateViewProps = { phase: "wiping" };

const meta = { title: "Mobile/Shell/WipeState", component: WipeStateView, args: base };
export default meta;

export const Wiping = { args: {} };
export const Failed = { args: { phase: "failed" } };
