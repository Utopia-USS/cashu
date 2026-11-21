import type { ReactNode } from "react";
import type { Meta, Story } from "../charts/testing/csf.js";
import { ToastProvider } from "./Toast.js";

interface ProviderArgs {
  children: ReactNode;
}

const meta = {
  title: "Feedback/ToastProvider",
  component: ToastProvider,
  args: { children: "Screen content; toasts appear at the bottom centre." },
} satisfies Meta<ProviderArgs>;
export default meta;
export const Default: Story<ProviderArgs> = {};
