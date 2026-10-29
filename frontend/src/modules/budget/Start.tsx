// Budget first steps in the app (design/v3/first-steps section 3): the first bank statement (the import creates
// the account), merchants without a category, transfers between own accounts. Rendered for the empty Wydatki tab
// and for `setup/budget`; every primary action is in the app (drawers, one POST).
import { useRef, useState } from "react";
import { useShell } from "../../core/context";
import { errorText } from "../../core/messages";
import { stepById } from "../../core/setupSteps";
import { StartPage, useSetupPoll } from "../../core/StartPage";
import type { ModuleCtx } from "../../core/types";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { type SetupStepItem, Tag, useToast } from "../../ui";
import { getImporters, getUncategorized, postMatchTransfers, type StatementCommit } from "./api";
import { CategoriesDrawer } from "./CategoriesDrawer";
import { StatementImportDrawer } from "./ImportDrawer";
import { bankAccounts, statementDone } from "./logic";
import { S } from "./Start.strings.ts";

type DrawerKind = "import" | "categories";

export function BudgetStart({ ctx }: { ctx: ModuleCtx }) {
  const { slug } = ctx;
  const { view, reloadProfiles } = useShell();
  const toast = useToast();
  const [drawer, setDrawer] = useState<DrawerKind | null>(null);
  const [busy, setBusy] = useState(false);
  const stale = useRef(false);
  const setup = useSetupPoll(slug, "budget", ctx.state, drawer != null);
  const steps = setup.data?.steps ?? null;
  const st = stepById(steps, "statement", "first_import");
  const cat = stepById(steps, "categories");
  const tr = stepById(steps, "transfers");
  const catOn = cat?.status === "on";
  const unc = useAsync(() => (catOn ? getUncategorized(slug, 30) : Promise.resolve(null)), [slug, catOn, setup.data?.state]);
  const accounts = bankAccounts(ctx.networth.accounts);
  const importers = useAsync(() => getImporters(slug).catch(() => null), [slug], { key: ck(slug, "budget", "importers") });
  const inSetupView = view.kind === "setup";

  const closeDrawer = (changed = false) => {
    setDrawer(null);
    setup.reload();
    if (stale.current || changed) {
      stale.current = false;
      ctx.refresh();
      void reloadProfiles();
    }
  };
  const match = async () => {
    setBusy(true);
    try {
      const r = await postMatchTransfers(slug);
      toast(r.pairs ? S.matched(r.pairs) : S.noPairs, 3000);
      setup.reload();
      if (r.pairs) { ctx.refresh(); void reloadProfiles(); }
    } catch (e) {
      toast(S.notMatched(errorText(e)), 5000);
    } finally { setBusy(false); }
  };

  const items: SetupStepItem[] | null = steps ? [
    {
      key: "statement", status: st?.status ?? "on", title: S.statementTitle,
      tag: st?.status === "done" && accounts.length ? <Tag tone="pos">{S.nAccounts(accounts.length)}</Tag> : undefined,
      hint: st?.status === "done" && accounts.length ? statementDone(accounts, importers.data?.importers) : S.statementHint,
      actions: st?.status === "done"
        ? <button className="btn" onClick={() => setDrawer("import")}>{S.importAnother}</button>
        : <button className="btn primary" onClick={() => setDrawer("import")}>{S.importStatement}</button>,
    },
    {
      key: "categories", status: cat?.status ?? "todo", title: S.categoriesTitle,
      hint: catOn
        ? unc.data ? S.categoriesCount(unc.data.length) : S.categoriesHint
        : cat?.status === "done" ? cat.description : undefined,
      actions: catOn ? (
        <>
          <button className="btn primary" onClick={() => setDrawer("categories")}>{S.review}</button>
          {inSetupView && <button className="btn" onClick={() => ctx.go({ kind: "tab", tab: "budget.expenses" })}>{S.expensesLink}</button>}
        </>
      ) : undefined,
    },
    {
      key: "transfers", status: tr?.status ?? "todo", title: S.transfersTitle,
      hint: tr?.description,
      actions: tr?.status === "on"
        ? <button className="btn primary" disabled={busy} onClick={() => void match()}>{busy ? S.matching : S.match}</button>
        : undefined,
    },
  ] : null;

  return (
    <StartPage moduleId="budget" title={S.title} setup={setup.data} state={ctx.state} steps={items}>
      {drawer === "import" && (
        <StatementImportDrawer slug={slug} initialStep={0} onClose={() => closeDrawer()}
          onDone={(r: StatementCommit) => { stale.current = true; toast(S.importedN(r.inserted), 3500); }} />
      )}
      {drawer === "categories" && <CategoriesDrawer slug={slug} categories={ctx.categories} onClose={(changed) => closeDrawer(changed)} />}
    </StartPage>
  );
}
