import type { Meta, Story } from "../charts/testing/csf.js";
import { Button } from "./Button.js";
import type { ButtonProps } from "./Button.types.js";

const richTitle = "Strategy notes";
const richSubtitle = "Updated weekly";
const meta = {
  title: "Controls/Button",
  component: Button,
  args: { children: "Continue" },
} satisfies Meta<ButtonProps>;
export default meta;
export const Primary: Story<ButtonProps> = { args: { variant: "primary" } };
export const Secondary: Story<ButtonProps> = {};
export const Danger: Story<ButtonProps> = { args: { variant: "danger" } };
export const Ghost: Story<ButtonProps> = { args: { variant: "ghost" } };
export const Disabled: Story<ButtonProps> = { args: { disabled: true } };
export const Small: Story<ButtonProps> = { args: { size: "sm" } };
export const Large: Story<ButtonProps> = { args: { size: "lg" } };
export const Pressed: Story<ButtonProps> = { args: { pressed: true, children: "Preview" } };
export const Current: Story<ButtonProps> = { args: { current: "page", children: "Topics" } };
export const Expanded: Story<ButtonProps> = {
  args: { expanded: false, children: "All categories" },
};
export const IconWithLabel: Story<ButtonProps> = {
  args: { label: "Previous month", children: "‹" },
};
export const RichContent: Story<ButtonProps> = {
  args: {
    className: "flex w-full justify-between gap-3 text-left",
    children: (
      <>
        <strong>{richTitle}</strong>
        <span>{richSubtitle}</span>
      </>
    ),
  },
};
export const Pending: Story<ButtonProps> = { args: { variant: "primary", pending: true } };
export const PendingSecondary: Story<ButtonProps> = { args: { pending: true, children: "Sync" } };
