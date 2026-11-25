import type { Meta, Story } from "../charts/testing/csf.js";
import { FactFlow, type FactFlowProps } from "./FactFlow.js";

const meta = {
  title: "Surfaces/FactFlow",
  component: FactFlow,
  args: {
    items: [
      { id: "s", label: "Nadwyżka X", value: "7 014 zł" },
      { id: "p", label: "Plan wpłaty", value: "2 500 zł", detail: "do 10. dnia" },
      { id: "z", label: "Zostaje", value: "2 514 zł", detail: "na koncie" },
    ],
  },
} satisfies Meta<FactFlowProps>;
export default meta;
export const Default: Story<FactFlowProps> = {};
