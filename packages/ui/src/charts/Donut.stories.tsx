// Stories of the donut (synthetic data): an allocation, a single full ring, a centre value, the centre in
// privacy mode and an empty donut.
import { Donut } from "./Donut.js";
import { type Meta, privacyMode, type Story } from "./testing/csf.js";
import type { DonutProps } from "./types.js";

const meta = {
  title: "Charts/Donut",
  component: Donut,
  args: {
    label: "Allocation",
    segments: [
      { value: 54.1, color: 1, name: "Equities" },
      { value: 24.5, color: 2, name: "Bonds" },
      { value: 16.1, color: 3, name: "Cash" },
      { value: 5.3, color: 4, name: "Gold" },
    ],
  },
} satisfies Meta<DonutProps>;
export default meta;

export const Allocation: Story<DonutProps> = {};

export const SingleSegment: Story<DonutProps> = {
  args: { segments: [{ value: 10, color: 1, name: "Equities" }] },
};

export const WithCenter: Story<DonutProps> = {
  args: { size: 140, center: { title: "184k", caption: "4 assets", amount: true } },
};

export const CenterInPrivacyMode: Story<DonutProps> = {
  args: { ...WithCenter.args },
  decorators: [privacyMode],
};

export const Empty: Story<DonutProps> = {
  args: {
    segments: [
      { value: 0, color: 1, name: "Equities" },
      { value: 0, color: 2, name: "Bonds" },
    ],
  },
};

export const Interactive: Story<DonutProps> = {
  args: { onSegmentSelected: () => {} },
};
