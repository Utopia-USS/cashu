import { useProfile } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import type { PerfRange } from "@cashu/ui-logic/investments/v2/types";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { AssetResearchBlock } from "../research/AssetResearchBlock.js";
import type { SignalsPageKind } from "../signals/useSignalsScreen.js";
import { AssetDetailView } from "./AssetDetailView.js";
import { InvestmentsHomeScreen } from "./home/InvestmentsHomeScreen.js";
import { PortfolioDrawersView } from "./PortfolioDrawersView.js";
import { type PortfolioScreenOptions, usePortfolioScreen } from "./usePortfolioScreen.js";

type PortfolioExtras = {
  /** The profile slug (the Home's first-steps command line). */
  slug?: string;
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
  onSetupOpened?(): void;
  onSettingsOpened?(): void;
};
type Props = Omit<PortfolioScreenOptions, "today"> & PortfolioExtras;

const RANGES: readonly PerfRange[] = ["1m", "3m", "ytd", "1y", "3y", "max"];
const rangeOf = (range: string | undefined): PerfRange => RANGES.find((r) => r === range) ?? "1y";

/** The investments tab: the Home (ab24ab6 v2/Home.tsx, the review deck over it) or one instrument's page. */
export function PortfolioScreen(props: Props) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  if (!props.instrument)
    return (
      <InvestmentsHomeScreen
        key={`${vault}:${privacy}`}
        slug={props.slug ?? ""}
        account={props.account ?? null}
        range={rangeOf(props.range)}
        review={props.review ?? false}
        signalsOpen={props.signalsOpen}
        signalFocusId={props.signalFocusId}
        onAccountPicked={props.onAccountPicked}
        onRangePicked={props.onRangePicked}
        onReviewOpened={props.onReviewOpened}
        onReviewClosed={props.onReviewClosed}
        openPage={props.openPage}
        onSignalsPageOpened={props.onSignalsPageOpened}
        onSignalsClosed={props.onSignalsClosed}
        onResearchOpened={props.onResearchOpened}
        onProposalOpened={props.onProposalOpened}
        onSetupOpened={props.onSetupOpened}
        onSettingsOpened={props.onSettingsOpened}
      />
    );
  return <InstrumentBound key={`${vault}:${privacy}:${props.instrument}`} {...props} />;
}

function InstrumentBound(props: Props) {
  const state = usePortfolioScreen({ today: useCalendarDay(), ...props });
  return (
    <>
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
