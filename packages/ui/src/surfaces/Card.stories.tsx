import type { Meta, Story } from "../charts/testing/csf.js";
import { Card } from "./Card.js";
import type { CardProps } from "./Card.types.js";

const meta = {
  title: "Surfaces/Card",
  component: Card,
  args: { label: "Research", children: "Topics, notes and model views in one place." },
} satisfies Meta<CardProps>;
export default meta;
export const Default: Story<CardProps> = {};
export const Large: Story<CardProps> = { args: { padding: "lg" } };
export const Status: Story<CardProps> = {
  args: { as: "p", role: "status", label: undefined, children: "Saved." },
};
export const Alert: Story<CardProps> = {
  args: { role: "alert", label: undefined, children: "The request was refused." },
};
export const Navigation: Story<CardProps> = {
  args: { as: "nav", label: "Files", className: "grid gap-2", children: "strategy.md" },
};
