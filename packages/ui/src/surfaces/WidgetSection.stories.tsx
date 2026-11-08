import type { Meta, Story } from "../charts/testing/csf.js";
import { Widget, WidgetSection, type WidgetSectionProps } from "./Widget.js";

const meta = {
  title: "Surfaces/WidgetSection",
  component: WidgetSection,
  args: { title: "Signals", children: "Two new items since the review." },
} satisfies Meta<WidgetSectionProps>;
export default meta;
export const Default: Story<WidgetSectionProps> = {};
/** Sections of one quiet card (the investments rail): the second one sits under a hairline. */
export const InACard: Story<WidgetSectionProps> = {
  args: { controls: "All (8)", footer: "5 unchanged since the review" },
  decorators: [
    (Section) => (
      <Widget title={null} label="Rail" variant="quiet">
        <Section />
        <WidgetSection title="Alerts" footer="1 close · 0 fired" />
      </Widget>
    ),
  ],
};
