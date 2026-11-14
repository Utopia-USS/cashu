// The Investments tab root: the review slot and the top tabs (`?view=portfolio|signals|strategy` in the
// URL), with the current view's section inside. Every navigation of the tab starts here.
import { useLocalSearchParams, useRouter } from "expo-router";
import { InvestmentsView } from "../../../src/screens/investments/InvestmentsView";
import {
  INVESTMENTS_VIEWS,
  type InvestmentsViewName,
} from "../../../src/screens/investments/investments-contracts";
import { PortfolioView } from "../../../src/screens/investments/portfolio/PortfolioView";
import { usePortfolioSection } from "../../../src/screens/investments/portfolio/usePortfolioSection";
import { SignalsView } from "../../../src/screens/investments/signals/SignalsView";
import { useSignalsSection } from "../../../src/screens/investments/signals/useSignalsSection";
import { StrategyView } from "../../../src/screens/investments/strategy/StrategyView";
import { useStrategySection } from "../../../src/screens/investments/strategy/useStrategySection";
import { useInvestmentsScreen } from "../../../src/screens/investments/useInvestmentsScreen";

export { ErrorBoundary } from "expo-router";

function viewOf(param: string | string[] | undefined): InvestmentsViewName {
  const value = Array.isArray(param) ? param[0] : param;
  return INVESTMENTS_VIEWS.find((v) => v === value) ?? "portfolio";
}

function useNavigation() {
  const router = useRouter();
  return {
    openPosition: (gid: string) =>
      router.push({ pathname: "/(tabs)/investments/position/[gid]", params: { gid } }),
    openNote: (gid: string) =>
      router.push({ pathname: "/(tabs)/investments/note/[gid]", params: { gid } }),
    openAlert: (gid: string) => router.push({ pathname: "/sheet/alert/[gid]", params: { gid } }),
  };
}

function Portfolio() {
  const { openPosition } = useNavigation();
  return <PortfolioView {...usePortfolioSection({ openPosition })} />;
}

function Signals() {
  const { openAlert, openNote } = useNavigation();
  return <SignalsView {...useSignalsSection({ openAlert, openNote })} />;
}

function Strategy() {
  return <StrategyView {...useStrategySection()} />;
}

export default function InvestmentsRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ view?: string }>();
  const view = viewOf(params.view);
  const props = useInvestmentsScreen({
    view,
    onViewChanged: (next) => router.setParams({ view: next }),
    openReview: () => router.push("/modal/review"),
    openProfile: () => router.push("/sheet/profile"),
  });
  return (
    <InvestmentsView {...props}>
      {view === "portfolio" ? <Portfolio /> : view === "signals" ? <Signals /> : <Strategy />}
    </InvestmentsView>
  );
}
