import type { Meta, Story } from "../charts/testing/csf.js";
import { InstCardBody, type InstCardProps } from "./HoverCard.js";

const meta = {
  title: "Overlays/InstCardBody",
  component: InstCardBody,
  args: {
    tile: { monogram: "ACM" },
    name: "Acme Corp",
    detail: "ACM · XETRA",
    rows: [{ key: "ISIN", value: "XX0000000000", tone: "tnum" }],
    status: [{ text: "Prices stale", warn: true }],
  },
} satisfies Meta<InstCardProps>;
export default meta;
export const Default: Story<InstCardProps> = {};
export const Bare: Story<InstCardProps> = { args: { rows: [], status: [], detail: "" } };
/** With the asset row's strategy hint as a note (design V5). */
export const WithNote: Story<InstCardProps> = {
  args: {
    notes: [
      {
        key: "drawdown_review",
        label: "Strategy",
        text: "-26 % from the high: your strategy asks for a review.",
        tone: "rule",
      },
    ],
  },
};
