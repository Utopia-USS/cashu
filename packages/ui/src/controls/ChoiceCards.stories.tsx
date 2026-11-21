import type { Meta, Story } from "../charts/testing/csf.js";
import { ChoiceCard, ChoiceCards, type ChoiceCardsProps } from "./ChoiceCard.js";

const meta = {
  title: "Controls/ChoiceCards",
  component: ChoiceCards,
  args: {
    children: (
      <>
        <ChoiceCard
          checked
          title="Budżet"
          desc="Wydatki, przepływy, subskrypcje."
          onChange={() => {}}
        />
        <ChoiceCard
          checked={false}
          title="Inwestycje"
          desc="Portfel, sygnały, przegląd."
          onChange={() => {}}
        />
      </>
    ),
  },
} satisfies Meta<ChoiceCardsProps>;
export default meta;
export const Default: Story<ChoiceCardsProps> = {};
