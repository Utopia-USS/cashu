// Stories of the sparkline (synthetic data): rising, falling, flat, a tone override, too short to draw,
// and labelled vs decorative.
import { Sparkline } from "./Sparkline.js";
import type { Meta, Story } from "./testing/csf.js";
import type { SparklineProps } from "./types.js";

const meta = {
  title: "Charts/Sparkline",
  component: Sparkline,
  args: { values: [10, 12, 11, 14, 13, 16], label: "30 days" },
} satisfies Meta<SparklineProps>;
export default meta;

export const Rising: Story<SparklineProps> = {};

export const Falling: Story<SparklineProps> = { args: { values: [16, 13, 14, 11, 12, 10] } };

export const Flat: Story<SparklineProps> = { args: { values: [5, 5, 5, 5] } };

export const ToneOverride: Story<SparklineProps> = { args: { tone: "muted" } };

export const WithGaps: Story<SparklineProps> = { args: { values: [null, 4, undefined, 6, 5] } };

export const TooShort: Story<SparklineProps> = { args: { values: [3] } };

export const Decorative: Story<SparklineProps> = { args: { label: undefined } };
