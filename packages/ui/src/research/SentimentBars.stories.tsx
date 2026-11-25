import type { Meta, Story } from "../charts/testing/csf.js";
import { type SentimentBar, SentimentBars, type SentimentBarsProps } from "./SentimentBars.js";

const values = [0.2, null, -0.4, 0.6, 0, 0.3, -0.1, 0.5];
const layout = (w: number, h: number, band: number) => {
  const mid = Math.round((h - band) / 2) + 0.5;
  const slot = w / values.length;
  const bw = Math.max(2, Math.min(14, slot * 0.58));
  const bars = values.map((v, i): SentimentBar => {
    const x = i * slot + (slot - bw) / 2;
    if (v == null) return { x, y: mid - 1, w: bw, h: 2, cls: "none" };
    const bh = Math.max(2, Math.abs(v) * (mid - 2));
    return {
      x,
      y: v >= 0 ? mid - bh : mid,
      w: bw,
      h: bh,
      cls: v > 0 ? "pos" : v < 0 ? "neg" : "none",
    };
  });
  return { mid, bars, bw };
};

const meta = {
  title: "Research/SentimentBars",
  component: SentimentBars,
  args: { label: "Sentiment over 8 weeks", size: "sm", layout },
} satisfies Meta<SentimentBarsProps>;
export default meta;
export const Small: Story<SentimentBarsProps> = {};
export const Large: Story<SentimentBarsProps> = {
  args: { size: "lg", labels: ["7.09", "", "21.09", "", "5.10", "", "19.10", ""] },
};
