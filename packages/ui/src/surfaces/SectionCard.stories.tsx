import type { Meta, Story } from "../charts/testing/csf.js";
import { SectionCard, type SectionCardProps } from "./SectionCard.js";

const meta = {
  title: "Surfaces/SectionCard",
  component: SectionCard,
  args: { id: "set-profile", title: "Profile", children: "Name and base currency" },
} satisfies Meta<SectionCardProps>;
export default meta;
export const Default: Story<SectionCardProps> = {};
