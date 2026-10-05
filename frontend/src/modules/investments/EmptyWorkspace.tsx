// W4: a new profile's workspace explains itself - setup steps where the data will be, ghost panels
// saying what appears where, the privacy notice. Strategy first, purchases later.
import { useShell } from "../../core/context";
import { PRIVACY_PLAIN } from "../../core/SetupPage";
import { Code, Ghost, Notice, SetupSteps, type SetupStepItem, Tag } from "../../ui";
import type { AccountRow, StrategyStatus } from "./api";
import { accountLabel, dm, isoDate, WEEKDAY_INDEX, WEEKDAYS } from "./labels";

export function EmptyWorkspace({ accounts, strategy, hasTxn, onAddAccount, onInitStrategy, onAddTxn, onImport, initBusy }: {
  accounts: AccountRow[];
  strategy: StrategyStatus | null;
  hasTxn: boolean;
  onAddAccount: () => void;
  onInitStrategy: () => void;
  onAddTxn: () => void;
  onImport: () => void;
  initBusy: boolean;
}) {
  const { profile, slug, go } = useShell();
  const hasAccount = accounts.length > 0;
  const hasStrategy = !!strategy && strategy.state !== "missing";
  const first = accounts[0];
  const weekday = strategy?.facts?.notifications.digest_weekday ?? "sunday";
  const sunday = nextWeekday(weekday);
  const steps: SetupStepItem[] = [
    {
      key: "account", status: hasAccount ? "done" : "on", title: "Rachunek maklerski",
      hint: hasAccount ? accounts.map((a) => `${accountLabel(a, accounts)} · ${a.currency}`).join(" · ") : "Rachunek = jeden broker + jedno opakowanie (zwykłe, IKE, IKZE).",
      actions: <button className={`btn ${hasAccount ? "" : "primary"}`} onClick={onAddAccount}>{hasAccount ? "Dodaj kolejny" : "Dodaj rachunek"}</button>,
    },
    {
      key: "strategy", status: hasStrategy ? "done" : hasAccount ? "on" : "todo", title: "Strategia",
      tag: hasStrategy ? <Tag tone="pos">{strategy!.version != null ? `v${strategy!.version}` : "zapisana"}</Tag> : <Tag tone="info">zalecane teraz</Tag>,
      hint: hasStrategy
        ? "Strategia zapisana. Koszyki i cele pojawią się w alokacji od pierwszej wyceny."
        : <>Cel, horyzont, koszyki i reguły w <code>strategy.yaml</code>, opis w <code>strategy.md</code>. Najprościej przez wywiad w Claude Code: <code>/investments-setup</code>; agent zaproponuje strategię, a Ty zatwierdzisz ją tutaj.</>,
      actions: hasStrategy ? undefined : (
        <>
          <button className={`btn ${hasAccount ? "primary" : ""}`} onClick={onInitStrategy} disabled={initBusy}>{initBusy ? "Tworzę…" : "Utwórz z szablonu"}</button>
          <button className="btn" onClick={() => go({ kind: "setup", module: "investments" })}>Instrukcja Claude Code</button>
        </>
      ),
    },
    {
      key: "txn", status: hasTxn ? "done" : hasStrategy ? "on" : "todo", title: "Pierwsza wpłata lub zakup",
      hint: "Dodaj transakcję ręcznie albo zaimportuj plik od brokera (format finanse lub CSV z mapowaniem kolumn). Pierwsza wpłata uruchamia regułę „brak wpłaty\" wg planu ze strategii.",
      actions: hasAccount ? (
        <>
          <button className="btn" onClick={onAddTxn}>Dodaj transakcję</button>
          <button className="btn" onClick={onImport}>Import</button>
        </>
      ) : undefined,
    },
    {
      key: "review", status: "todo", title: "Pierwszy przegląd tygodnia",
      hint: `${capital(WEEKDAYS[weekday] ?? weekday)} ${dm(sunday)} · podsumowanie przyjdzie o poranku, gdy będzie co podsumować.`,
    },
  ];
  return (
    <div className="ws">
      <div className="main">
        <section className="card chart-card empty-ws">
          <div className="lead">
            <b>Portfel jest pusty - i to w porządku.</b>
            <span>Zacznij od strategii, a nie od zakupów: reguły i alokacja zaczną działać od pierwszej wyceny.</span>
          </div>
          <SetupSteps steps={steps} />
          {!hasAccount && <Code cmd={`finanse --profile ${slug} invest accounts add "XTB IKE" --broker xtb --wrapper ike`} />}
          {first && hasTxn && <div className="foot">Pierwsze transakcje są zapisane - pozycje pojawią się po przeliczeniu.</div>}
        </section>
        <Ghost title="Alokacja vs cel">Pojawi się po zapisaniu strategii: koszyki, cele i pasma z <code>strategy.yaml</code>, nawet zanim kupisz cokolwiek (wszystko w „do celu").</Ghost>
        <Ghost title="Pozycje">Po pierwszej transakcji: loty FIFO, wycena po kursie z dnia, teza do każdej pozycji, wykres z progami reguł.</Ghost>
      </div>
      <aside className="rail">
        <Ghost title="Do decyzji">Sygnały z reguł pojawiają się tu po pierwszej wycenie. Decyzję zapisujesz w miejscu, trafia do dziennika.</Ghost>
        <Ghost title="Przegląd tygodnia">Co niedzielę: co się zmieniło, sygnały do rozstrzygnięcia, jedno kliknięcie „zrobione". Zwykle 20-40 minut.</Ghost>
        <Notice tone="info" action={<button className="lnk" onClick={() => go({ kind: "settings", section: "agent" })}>Ustawienia</button>}>
          {PRIVACY_PLAIN[profile.mcp_privacy] ?? PRIVACY_PLAIN.strict}
        </Notice>
      </aside>
    </div>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function nextWeekday(weekday: string): string {
  const t = new Date();
  const want = WEEKDAY_INDEX[weekday] ?? 0;
  const add = (want - t.getDay() + 7) % 7 || 7;
  return isoDate(new Date(t.getFullYear(), t.getMonth(), t.getDate() + add));
}
