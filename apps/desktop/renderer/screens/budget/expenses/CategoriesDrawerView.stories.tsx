import { CategoriesDrawerView } from "./CategoriesDrawerView.js";
import type { CategoriesDrawerState } from "./useCategoriesDrawer.js";

const ready: CategoriesDrawerState = {
  rows: [
    {
      key: "sklep demo",
      sample: "SKLEP DEMO",
      sub: "sklep demo",
      title: "SKLEP DEMO\nsklep demo",
      count: "3",
      total: "120 zł",
      picked: "",
      saved: false,
      choose: () => {},
    },
  ],
  options: [{ value: "", label: "wybierz…" }],
  error: null,
  busy: false,
  close: () => {},
};

export default {
  title: "Desktop/Budget/Categories drawer",
  component: CategoriesDrawerView,
  args: { state: ready },
};
export const Ready = {};
export const AllDone = { args: { state: { ...ready, rows: [] } } };
