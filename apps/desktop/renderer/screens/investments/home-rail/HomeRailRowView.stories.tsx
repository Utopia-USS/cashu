import { HomeRailRowView } from "./HomeRailView.js";

export default {
  title: "Desktop/Investments/HomeRailRow",
  component: HomeRailRowView,
  args: {
    tile: "ACM",
    title: "Synthetic subject",
    text: "A short synthetic sentence.",
    note: "put off until 8 Nov",
  },
};
export const Plain = {};
export const Linked = { args: { onOpen() {} } };
