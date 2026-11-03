import { useProfile } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { AssetDetailView } from "./AssetDetailView.js";
import { PortfolioDrawersView } from "./PortfolioDrawersView.js";
import { PortfolioView } from "./PortfolioView.js";
import { type PortfolioScreenOptions, usePortfolioScreen } from "./usePortfolioScreen.js";

export function PortfolioScreen(props: Omit<PortfolioScreenOptions, "today">) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return <PortfolioBound key={`${vault}:${privacy}:${props.instrument ?? ""}`} {...props} />;
}
function PortfolioBound(props: Parameters<typeof PortfolioScreen>[0]) {
  const state = usePortfolioScreen({ today: useCalendarDay(), ...props });
  return (
    <>
      {!props.instrument && <PortfolioView state={state} />}
      <AssetDetailView state={state} />
      <PortfolioDrawersView state={state} />
    </>
  );
}
