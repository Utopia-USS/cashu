// The mountable ported signals dialog: the Home renders it while the dialog is open (inside the Home's
// ToastProvider: the writes toast with `Cofnij`), and a group's position decision dialog above it. Also the
// standalone position decision dialog for the asset page (old Decide.tsx PositionDecisionDialog).
// Contract: ~/cashu-lab/checkpoints/investments-ui-poc/contract-A2.md.
import type { Thesis } from "@cashu/ui-logic/investments/types";
import type { SignalV2 } from "@cashu/ui-logic/investments/v2/types";
import type { InvestmentsHomeData } from "../investments/home/useInvestmentsHomeData.js";
import { PositionDecisionView, SignalsDialogView } from "./SignalsDialogView.js";
import { signalsCtxOf } from "./signalsCtx.js";
import { type PositionDecisionInput, usePositionDecision } from "./usePositionDecision.js";
import { type SignalsDialogInput, useSignalsDialog } from "./useSignalsDialog.js";

export type { SignalsDialogInput };

function PositionDecision(props: PositionDecisionInput) {
  const p = usePositionDecision(props);
  return p ? <PositionDecisionView p={p} /> : null;
}

export function SignalsDialogScreen(props: SignalsDialogInput) {
  const { position, ...view } = useSignalsDialog(props);
  return (
    <>
      <SignalsDialogView {...view} />
      {position && <PositionDecision key={position.instrumentId} {...position} />}
    </>
  );
}

export interface PositionDecisionScreenProps {
  /** The Home's reads (useInvestmentsHomeData). */
  data: InvestmentsHomeData;
  /** The instrument (legacy number). */
  instrumentId: number;
  /** Its undecided open signals (byTime order); all are covered by the decision. */
  signals: SignalV2[];
  thesis: Thesis | null;
  onClose(): void;
  onSaved?(): void;
}

/** Old PositionDecisionDialog over the asset page or drawer (the header's `Zanotuj decyzję`). */
export function PositionDecisionScreen({ data, ...props }: PositionDecisionScreenProps) {
  return <PositionDecision ctx={signalsCtxOf(data)} {...props} />;
}
