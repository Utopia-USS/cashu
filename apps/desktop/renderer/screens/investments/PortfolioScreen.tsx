import { lang } from "@cashu/i18n";
import { researchScreenQueries } from "@cashu/store/investments/research-screen";
import { useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useEffect } from "react";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { AssetResearchBlock } from "../research/AssetResearchBlock.js";
import { ResearchHomeSection } from "../research/ResearchHomeSection.js";
import { useResearchCandidatesRail } from "../research/useResearchCandidatesRail.js";
import { ReviewEntryView } from "../review/ReviewEntryView.js";
import { ReviewScreen } from "../review/ReviewScreen.js";
import { useReviewEntry } from "../review/useReviewEntry.js";
import { SignalsDialogView } from "../signals/SignalsView.js";
import { type SignalsPageKind, useSignalsScreen } from "../signals/useSignalsScreen.js";
import { AssetDetailView } from "./AssetDetailView.js";
import { candidateRailModel } from "./candidateRailModel.js";
import { CandidatesRailView } from "./home-rail/CandidatesRailView.js";
import { HomeRailView } from "./home-rail/HomeRailView.js";
import { homeRailModel } from "./homeRailModel.js";
import { PortfolioDrawersView } from "./PortfolioDrawersView.js";
import { PortfolioView } from "./PortfolioView.js";
import { type PortfolioScreenOptions, usePortfolioScreen } from "./usePortfolioScreen.js";

type PortfolioExtras = {
  review?: boolean;
  signalsOpen?: boolean;
  signalFocusId?: string;
  noteGid?: string | null;
  onReviewClosed?(): void;
  onReviewOpened?(): void;
  onProposalOpened?(gid: string, onResumed: () => void): boolean;
  onSignalsClosed?(): void;
  onSignalsPageOpened?(page: SignalsPageKind, newAlert?: boolean): void;
  onResearchOpened?(tab?: string, topic?: string, note?: string): void;
};
type Props = Omit<PortfolioScreenOptions, "today"> & PortfolioExtras;
const researchQueries = researchScreenQueries();
export function PortfolioScreen(props: Props) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <PortfolioBound
      key={`${vault}:${privacy}:${props.instrument ?? ""}:${props.review ?? false}`}
      {...props}
    />
  );
}
function PortfolioBound(props: Props) {
  const state = usePortfolioScreen({ today: useCalendarDay(), ...props });
  if (props.review)
    return (
      <ReviewScreen
        account={props.account}
        onClosed={props.onReviewClosed ?? (() => {})}
        onInstrumentOpened={props.openPage}
        onProposalOpened={props.onProposalOpened}
        onResearchOpened={(input) => props.onResearchOpened?.(undefined, input.topic, input.note)}
      />
    );
  return (
    <>
      {!props.instrument && <PortfolioHome state={state} {...props} />}
      <AssetDetailView state={state} />
      {props.instrument && (
        <AssetResearchBlock
          instrument={props.instrument}
          held={
            state.portfolio.status === "ready" &&
            state.portfolio.positions.positions.some(
              (row) => row.instrument.id === props.instrument,
            )
          }
          noteGid={props.noteGid}
          onOpenNote={(note) => props.onResearchOpened?.(undefined, undefined, note)}
        />
      )}
      <PortfolioDrawersView state={state} />
    </>
  );
}
function PortfolioHome({
  state,
  ...props
}: Props & { state: ReturnType<typeof usePortfolioScreen> }) {
  const { privacy } = useUiEnv();
  const signals = useSignalsScreen({
    initialSignal: props.signalFocusId,
    onOpenAsset: props.openPage,
    onOpenReview: props.onReviewOpened,
    onOpenPage: props.onSignalsPageOpened,
    onClose: props.onSignalsClosed,
    onOpenNote: (note) => props.onResearchOpened?.(undefined, undefined, note ?? undefined),
  });
  const { setDialogOpen } = signals;
  useEffect(() => {
    if (props.signalsOpen) setDialogOpen(true);
  }, [props.signalsOpen, setDialogOpen]);
  const research = useQuery(researchQueries.screen, { today: useCalendarDay(), lang: lang() });
  const candidateActions = useResearchCandidatesRail();
  const review = useReviewEntry(props.onReviewOpened, state.account);
  const homeRail = homeRailModel(
    signals,
    review,
    props.onReviewOpened ?? (() => {}),
    () => props.onSignalsPageOpened?.("alerts"),
    () => props.onSignalsPageOpened?.("alerts", true),
    props.openPage,
  );
  const openAsset = (gid: string, note?: string) =>
    note ? props.onResearchOpened?.(undefined, undefined, note) : props.openPage?.(gid);
  return (
    <>
      <PortfolioView state={state} homeRail={<HomeRailView privacy={privacy} {...homeRail} />} />
      <div className="grid gap-6 px-6 pb-6" data-testid="native-investment-home-rails">
        <ResearchHomeSection
          data={research}
          privacy={privacy}
          onOpenResearch={(tab) => props.onResearchOpened?.(tab)}
          onOpenTopic={(topic) => props.onResearchOpened?.(undefined, topic)}
          onOpenAsset={openAsset}
        />
        <CandidatesRailView
          {...candidateRailModel(
            research,
            privacy,
            candidateActions,
            () => props.onResearchOpened?.("candidates"),
            (note) => props.onResearchOpened?.(undefined, undefined, note),
            Date.parse(signals.displayNow),
          )}
        />
        <ReviewEntryView state={review} onOpened={props.onReviewOpened ?? (() => {})} />
        <SignalsDialogView state={signals} />
      </div>
    </>
  );
}
