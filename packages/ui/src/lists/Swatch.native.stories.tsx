import type { Meta, Story } from "../charts/testing/csf.js";
import { Swatch, type SwatchColor } from "./Swatch.js";

interface SwatchStoryProps {
  color: SwatchColor;
}

const meta = {
  title: "Native/Swatch",
  component: Swatch,
  args: { color: "palette-1" },
} satisfies Meta<SwatchStoryProps>;
export default meta;
export const Palette: Story<SwatchStoryProps> = {};
export const Accent: Story<SwatchStoryProps> = { args: { color: "accent" } };
export const Muted: Story<SwatchStoryProps> = { args: { color: "fg-muted" } };
