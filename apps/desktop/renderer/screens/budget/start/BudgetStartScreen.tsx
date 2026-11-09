// The budget first steps route body: the hook, the view with the Claude Code card under the steps, and the drawers
// it opens (the statement import at its source step, E's categories drawer).
import type { IsoDate } from "@cashu/domain";
import { S } from "@cashu/i18n/budget/Start.strings";
import { ToastProvider, useToast } from "@cashu/ui";
import { SetupAgentCard } from "../../setup/SetupAgentCard.js";
import { useBankingStatus } from "../actions/useBankingStatus.js";
import { CategoriesDrawer } from "../expenses/CategoriesDrawer.js";
import { StatementImportView } from "../import/StatementImportView.js";
import { useStatementImport } from "../import/useStatementImport.js";
import { BudgetStartView } from "./BudgetStartView.js";
import { useBudgetStart } from "./useBudgetStart.js";

export interface BudgetStartScreenProps {
  today: IsoDate;
  slug: string;
  inSetupView: boolean;
  onExpenses(): void;
  /** `Ustawienia` on the Claude Code card's privacy line: Ustawienia › Agent AI. */
  onAgentSettings(): void;
}

function ImportDrawer(props: { slug: string; onClose(): void; onExpenses(): void }) {
  const banking = useBankingStatus();
  const toast = useToast();
  const state = useStatementImport({
    slug: props.slug,
    initialStep: 0,
    ebConfigured: banking.configured,
    onClose: props.onClose,
    // `Instrukcja`: the Claude Code card is under the steps of this page.
    onInstructions: props.onClose,
    onCopy: (text) => void navigator.clipboard.writeText(text),
    onDone: (inserted) => toast(S.importedN(inserted), 3500),
    onExpenses: props.onExpenses,
  });
  return <StatementImportView state={state} />;
}

function Body(props: BudgetStartScreenProps) {
  const state = useBudgetStart(props);
  return (
    <BudgetStartView
      state={state}
      agent={<SetupAgentCard moduleId="budget" onSettings={props.onAgentSettings} />}
    >
      {state.drawer === "import" && (
        <ImportDrawer slug={props.slug} onClose={state.closeDrawer} onExpenses={props.onExpenses} />
      )}
      {state.drawer === "categories" && (
        <CategoriesDrawer currency={state.currency} onClose={() => state.closeDrawer()} />
      )}
    </BudgetStartView>
  );
}

export function BudgetStartScreen(props: BudgetStartScreenProps) {
  return (
    <ToastProvider>
      <Body {...props} />
    </ToastProvider>
  );
}
