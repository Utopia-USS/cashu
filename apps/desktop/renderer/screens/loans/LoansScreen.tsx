// The Kredyty route body (ab24ab6 modules/loans/index.tsx tab + Start): the old shell showed an empty module's
// first steps on its tab, `setup/loans` always shows them. Drafts and pending completions are keyed to the
// selected vault and the privacy mode.
import { S as L } from "@cashu/i18n/loans/Loans.strings";
import { useProfile } from "@cashu/store-react";
import {
  Page,
  SkeletonChart,
  SkeletonKpis,
  SkeletonTable,
  ToastProvider,
  useUiEnv,
} from "@cashu/ui";
import { Suspense } from "react";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { SetupAgentCard } from "../setup/SetupAgentCard.js";
import { InstallmentDrawerView } from "./InstallmentDrawerView.js";
import { LoanDrawerView } from "./LoanDrawerView.js";
import { LoansStartView } from "./LoansStartView.js";
import { LoansView } from "./LoansView.js";
import { useLoansScreen } from "./useLoansScreen.js";

export interface LoansScreenProps {
  /** `setup/loans`: the first steps even when loans exist. */
  setup?: boolean;
  /** The empty tab's "Konfiguracja" (`setup/loans`). */
  onSetup(): void;
  /** `Ustawienia` on the Claude Code card's privacy line: Ustawienia › Agent AI. */
  onAgentSettings(): void;
}

export function LoansScreen(props: LoansScreenProps) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <Page width="narrow" label={L.title} testID="native-loans">
      <ToastProvider>
        <Suspense
          fallback={
            <>
              <SkeletonTable rows={2} />
              <SkeletonKpis n={5} />
              <SkeletonChart />
            </>
          }
        >
          <LoansBound key={`${vault}:${privacy}`} {...props} />
        </Suspense>
      </ToastProvider>
    </Page>
  );
}

function LoansBound({ setup = false, onSetup, onAgentSettings }: LoansScreenProps) {
  const state = useLoansScreen(useCalendarDay());
  const drawers = (
    <>
      <LoanDrawerView state={state} />
      <InstallmentDrawerView state={state} />
    </>
  );
  return setup || state.empty ? (
    <LoansStartView
      state={state}
      agent={<SetupAgentCard moduleId="loans" onSettings={onAgentSettings} />}
    >
      {drawers}
    </LoansStartView>
  ) : (
    <LoansView state={state} onSetup={onSetup} />
  );
}
