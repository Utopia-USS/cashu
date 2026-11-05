// The budget's first steps (ab24ab6 modules/budget/Start.tsx): the first bank statement, merchants without a
// category, transfers between own accounts, from the native module setup steps. Rendered for the empty Wydatki
// tab and for `setup/budget`.
import type { IsoDate } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { S } from "@cashu/i18n/budget/Start.strings";
import { S as P } from "@cashu/i18n/core/SetupPage.strings";
import { S as N } from "@cashu/i18n/core/setupSteps.strings";
import { budgetDesktopQueries } from "@cashu/store/budget/queries";
import { profile } from "@cashu/store/core";
import { overviewQueries } from "@cashu/store/overview";
import { useQuery } from "@cashu/store-react";
import { useToast } from "@cashu/ui";
import { useState } from "react";
import { T } from "../BudgetShell.strings.js";
import { useBudgetCurrency } from "../expenses/budgetCurrency.js";

const q = overviewQueries({ prices: null });
const queries = budgetDesktopQueries();

type DrawerKind = "import" | "categories";
type StepTone = "positive" | "warning";

export function useBudgetStart(args: { today: IsoDate; inSetupView: boolean; onExpenses(): void }) {
  const toast = useToast();
  const identity = useQuery(profile);
  const setup = useQuery(q.moduleSetup, { module: "budget", cli: "", lang: lang() });
  const bc = useBudgetCurrency({ today: args.today, requested: undefined, onChange: () => {} });
  const settings = useQuery(queries.settings);
  const [drawer, setDrawer] = useState<DrawerKind | null>(null);
  const info = setup.ok ? setup.value : null;
  const steps = info?.steps ?? [];
  const byId = (id: string) => steps.find((s) => s.id === id) ?? null;
  const st = byId("statement");
  const cat = byId("categories");
  const tr = byId("transfers");
  const catOn = cat?.status === "on";
  const unc = useQuery(queries.uncategorized, { currency: bc.currency });
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.status === "done").length;
  const accounts = settings.accounts.length;
  const tag: { tone: StepTone; text: string } =
    info?.state === "ready"
      ? { tone: "positive", text: P.ready }
      : !info || !required.length
        ? { tone: "warning", text: P.notConfigured }
        : { tone: "warning", text: N.stepsOf(done, required.length) };
  return {
    title: S.title,
    tag,
    mcpPrivacy: identity?.mcpPrivacy ?? "strict",
    currency: bc.currency,
    steps: info
      ? [
          {
            key: "statement",
            status: st?.status ?? ("on" as const),
            title: S.statementTitle,
            tag: st?.status === "done" && accounts ? S.nAccounts(accounts) : null,
            hint: st?.status === "done" && accounts ? (st.description ?? "") : S.statementHint,
            actions:
              st?.status === "done"
                ? [{ label: S.importAnother, primary: false, onPress: () => setDrawer("import") }]
                : [{ label: S.importStatement, primary: true, onPress: () => setDrawer("import") }],
          },
          {
            key: "categories",
            status: cat?.status ?? ("todo" as const),
            title: S.categoriesTitle,
            tag: null,
            hint: catOn
              ? S.categoriesCount(unc.length)
              : cat?.status === "done"
                ? cat.description
                : undefined,
            actions: catOn
              ? [
                  {
                    label: S.review,
                    primary: true,
                    onPress: () => setDrawer("categories"),
                  },
                  ...(args.inSetupView
                    ? [{ label: S.expensesLink, primary: false, onPress: args.onExpenses }]
                    : []),
                ]
              : [],
          },
          {
            key: "transfers",
            status: tr?.status ?? ("todo" as const),
            title: S.transfersTitle,
            tag: null,
            hint: tr?.description,
            actions:
              tr?.status === "on"
                ? [
                    {
                      label: S.match,
                      primary: true,
                      onPress: () => toast(S.notMatched(T.unsupported), 5000),
                    },
                  ]
                : [],
          },
        ]
      : null,
    drawer,
    closeDrawer: () => setDrawer(null),
  };
}
export type BudgetStartState = ReturnType<typeof useBudgetStart>;
