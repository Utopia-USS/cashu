import { BootstrapView } from "./BootstrapView.js";
export default {
  title: "Desktop/Bootstrap",
  component: BootstrapView,
  args: { phase: "waiting", onRetried: () => {} },
};
export const Waiting = {};
export const Failed = { args: { phase: "failed" } };
