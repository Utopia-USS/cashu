import { AssetsStepsView, type AssetsStepsViewProps } from "./AssetsStepsView.js";

const args: AssetsStepsViewProps = {
  model: {
    position: "done",
    vehicle: "done",
    count: 2,
    totals: "Synthetic total",
    vehicles: [{ name: "Synthetic car", rate: "15", loss: "Synthetic loss" }],
  },
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
