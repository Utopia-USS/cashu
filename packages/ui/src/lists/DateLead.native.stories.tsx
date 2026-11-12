import type { Decorator, Meta, Story } from "../charts/testing/csf.js";
import { UiEnvProvider } from "../environment/UiEnv.js";
import { DateLead, type DateLeadProps } from "./ListRow.js";

const polish: Decorator = (Story) => (
  <UiEnvProvider privacy={false} locale="pl-PL">
    <Story />
  </UiEnvProvider>
);

const meta = {
  title: "Native/DateLead",
  component: DateLead,
  args: { date: "2026-11-12" },
} satisfies Meta<DateLeadProps>;
export default meta;
export const Default: Story<DateLeadProps> = {};
export const Polish: Story<DateLeadProps> = { decorators: [polish] };
