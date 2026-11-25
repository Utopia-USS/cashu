import type { Meta, Story } from "../charts/testing/csf.js";
import { HoverCard, type HoverCardProps } from "./HoverCard.js";

const meta = {
  title: "Overlays/HoverCard",
  component: HoverCard,
  args: {
    anchor: globalThis.document?.body as HTMLElement,
    id: "hover-card",
    children: "Acme Corp",
  },
} satisfies Meta<HoverCardProps>;
export default meta;
export const Default: Story<HoverCardProps> = {};
export const Gain: Story<HoverCardProps> = { args: { gain: true } };
