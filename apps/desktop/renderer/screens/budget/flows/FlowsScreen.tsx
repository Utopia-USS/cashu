// The Przepływy route body: the screen hook, E's month close card and currency switch, the view.
import type { IsoDate } from "@cashu/domain";
import { CurrencySwitch } from "../expenses/CurrencySwitch.js";
import { MonthCloseCard } from "../expenses/MonthCloseCard.js";
import { FlowsView } from "./FlowsView.js";
import { type FlowsFilters, useFlowsScreen } from "./useFlowsScreen.js";

export function FlowsScreen(props: {
  today: IsoDate;
  filters: FlowsFilters;
  onFilters(next: FlowsFilters): void;
}) {
  const state = useFlowsScreen(props);
  return (
    <FlowsView
      state={state}
      monthClose={
        <MonthCloseCard
          today={state.today}
          bc={state.bc}
          month={state.month}
          onMonth={state.onMonth}
        />
      }
      currencySwitch={<CurrencySwitch bc={state.bc} />}
    />
  );
}
