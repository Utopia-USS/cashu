// The budget first steps route body: the hook, the view, and the drawers it opens (the statement import at its
// source step, E's categories drawer).
import type { IsoDate } from "@cashu/domain";
import { ToastProvider } from "@cashu/ui";
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
  onGuide(): void;
  onAgentSettings(): void;
}

function ImportDrawer(props: { slug: string; onClose(): void; onGuide(): void }) {
  const banking = useBankingStatus();
  const state = useStatementImport({
    slug: props.slug,
    initialStep: 0,
    ebConfigured: banking.configured,
    onClose: props.onClose,
    onInstructions: props.onGuide,
    onCopy: (text) => void navigator.clipboard.writeText(text),
  });
  return <StatementImportView state={state} />;
}

function Body(props: BudgetStartScreenProps) {
  const state = useBudgetStart(props);
  return (
    <BudgetStartView state={state} onGuide={props.onGuide} onAgentSettings={props.onAgentSettings}>
      {state.drawer === "import" && (
        <ImportDrawer slug={props.slug} onClose={state.closeDrawer} onGuide={props.onGuide} />
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
