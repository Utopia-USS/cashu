// The Przepływy tab body (ab24ab6 modules/budget/Flows.tsx): the month close card, then the scrollable cash
// flow chart with the currency switch, the aggregation select and the range switch in its head. Pure.
import { S } from "@cashu/i18n/budget/Flows.strings";
import { ScrollableChart, Select } from "@cashu/ui";
import type { ReactNode } from "react";
import type { FlowsScreenState } from "./useFlowsScreen.js";

export interface FlowsViewProps {
  state: FlowsScreenState;
  /** The month close card (E's MonthCloseCard). */
  monthClose: ReactNode;
  /** The budget currency switch (E's CurrencySwitch). */
  currencySwitch: ReactNode;
}

export function FlowsView({ state, monthClose, currencySwitch }: FlowsViewProps) {
  return (
    <>
      {monthClose}
      <ScrollableChart
        key={`${state.gran}:${state.title}`}
        title={state.title}
        label={state.title}
        controls={
          <>
            {currencySwitch}
            <Select
              label={S.aggregation}
              labelHidden
              title={S.aggregation}
              value={state.gran}
              options={state.granOptions}
              onChange={state.onGran}
            />
          </>
        }
        ranges={state.ranges}
        range={state.range}
        onRangeChange={state.onRange}
        labels={state.labels}
        bars={state.bars}
        line={state.line}
        yFormat={state.yFormat}
        tooltip={state.tooltip}
        summary={state.summary}
      />
    </>
  );
}
