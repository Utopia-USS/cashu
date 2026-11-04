import type { Meta, Story } from "../charts/testing/csf.js";
import { Button } from "./Button.js";
import type { ButtonProps } from "./Button.types.js";

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
