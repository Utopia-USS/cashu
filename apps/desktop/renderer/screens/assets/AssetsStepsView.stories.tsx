import { AssetsStepsView, type AssetsStepsViewProps } from "./AssetsStepsView.js";

const args: AssetsStepsViewProps = {
  model: {
    position: "done",
    vehicle: "done",
    count: 2,
    totals: "Synthetic total",
    vehicles: [{ name: "Synthetic car", rate: "15", loss: "Synthetic loss" }],
  },
  privacy: false,
  onAdd: () => {},
};
export default { title: "Desktop/Assets/Steps", component: AssetsStepsView, args };
export const Ready = {};
export const Empty = {
  args: {
    ...args,
    compact: true,
    model: {
      position: "on" as const,
      vehicle: "todo" as const,
      count: 0,
      totals: "",
      vehicles: [],
    },
  },
};
export const Privacy = { args: { ...args, privacy: true } };
