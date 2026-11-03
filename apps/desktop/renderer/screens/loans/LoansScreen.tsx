import { useProfile } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { InstallmentDrawerView } from "./InstallmentDrawerView.js";
import { LoanDrawerView } from "./LoanDrawerView.js";
import { LoansStartView } from "./LoansStartView.js";
import { LoansView } from "./LoansView.js";
import { useLoansScreen } from "./useLoansScreen.js";

/** Route composition keys all drafts and pending completion callbacks to the selected vault. */
export function LoansScreen({ setup = false }: { setup?: boolean }) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return <LoansBound key={`${vault}:${privacy}`} setup={setup} />;
}
function LoansBound({ setup }: { setup: boolean }) {
  const state = useLoansScreen(useCalendarDay());
  return (
    <>
      <LoansView state={state} />
      {(setup || state.rows.length === 0) && (
        <div className="px-6 pb-6">
          <LoansStartView state={state} />
        </div>
      )}
      <LoanDrawerView state={state} />
      <InstallmentDrawerView state={state} />
    </>
  );
}
