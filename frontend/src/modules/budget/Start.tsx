// Budget first steps in the app (design/v3/first-steps section 3): the first bank statement (the import creates
// the account), merchants without a category, transfers between own accounts. Rendered for the empty Wydatki tab
// and for `setup/budget`; every primary action is in the app (drawers, one POST).
import { useRef, useState } from "react";
import { useShell } from "../../core/context";
import { errorText } from "../../core/messages";
import { stepById } from "../../core/setupSteps";
import { StartPage, useSetupPoll } from "../../core/StartPage";
import type { ModuleCtx } from "../../core/types";
import { plural } from "../../format";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { type SetupStepItem, Tag, useToast } from "../../ui";
import { getImporters, getUncategorized, postMatchTransfers, type StatementCommit } from "./api";
import { CategoriesDrawer } from "./CategoriesDrawer";
import { StatementImportDrawer } from "./ImportDrawer";
import { bankAccounts, statementDone } from "./logic";

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
      toast(r.pairs ? `Dopasowano ${plural(r.pairs, "parę", "pary", "par")} przelewów` : "Brak par do dopasowania", 3000);
      setup.reload();
      if (r.pairs) { ctx.refresh(); void reloadProfiles(); }
    } catch (e) {
      toast(`Nie dopasowano: ${errorText(e)}`, 5000);
    } finally { setBusy(false); }
  };

  const items: SetupStepItem[] | null = steps ? [
    {
      key: "statement", status: st?.status ?? "on", title: "Pierwszy wyciąg z banku",
      tag: st?.status === "done" && accounts.length ? <Tag tone="pos">{plural(accounts.length, "konto", "konta", "kont")}</Tag> : undefined,
      hint: st?.status === "done" && accounts.length ? statementDone(accounts, importers.data?.importers) : "Plik CSV (mBank, Pekao, Erste) albo Open Banking.",
      actions: st?.status === "done"
        ? <button className="btn" onClick={() => setDrawer("import")}>Importuj kolejny</button>
        : <button className="btn primary" onClick={() => setDrawer("import")}>Importuj wyciąg</button>,
    },
    {
      key: "categories", status: cat?.status ?? "todo", title: "Kategorie wydatków",
      hint: catOn
        ? unc.data ? `${plural(unc.data.length, "sprzedawca", "sprzedawców", "sprzedawców")} bez kategorii · reguła zapamięta wybór.` : "Najczęstsi sprzedawcy bez kategorii; reguła zapamięta wybór."
        : cat?.status === "done" ? cat.description : undefined,
      actions: catOn ? (
        <>
          <button className="btn primary" onClick={() => setDrawer("categories")}>Przejrzyj</button>
          {inSetupView && <button className="btn" onClick={() => ctx.go({ kind: "tab", tab: "budget.expenses" })}>Wydatki →</button>}
        </>
      ) : undefined,
    },
    {
      key: "transfers", status: tr?.status ?? "todo", title: "Przelewy między kontami",
      hint: tr?.description,
      actions: tr?.status === "on"
        ? <button className="btn primary" disabled={busy} onClick={() => void match()}>{busy ? "Dopasowuję…" : "Dopasuj"}</button>
        : undefined,
    },
  ] : null;

  return (
    <StartPage moduleId="budget" title="Budżet domowy" setup={setup.data} state={ctx.state} steps={items}>
      {drawer === "import" && (
        <StatementImportDrawer slug={slug} initialStep={0} onClose={() => closeDrawer()}
          onDone={(r: StatementCommit) => { stale.current = true; toast(`Zaimportowano ${plural(r.inserted, "transakcję", "transakcje", "transakcji")}`, 3500); }} />
      )}
      {drawer === "categories" && <CategoriesDrawer slug={slug} categories={ctx.categories} onClose={(changed) => closeDrawer(changed)} />}
    </StartPage>
  );
}
