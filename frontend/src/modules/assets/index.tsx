import type { ModuleDef } from "../../core/types";
import { cur } from "../../format";
import { FactList } from "../../ui";
import { Assets, isAsset } from "./Assets";

export const assets: ModuleDef = {
  id: "assets",
  name: "Majątek",
  desc: "Nieruchomości, auta i inne aktywa wyceniane ręcznie. Liczą się do wartości netto, auto traci na wartości wg krzywej.",
  short: "Nieruchomości, auta i inne aktywa wyceniane ręcznie",
  intro: "Moduł trzyma ręcznie wyceniane aktywa: mieszkanie, auto, inne. Wartości wchodzą do wartości netto i wykresu.",
  skillBlurb: "Skill {skill} zapyta o mieszkanie, auto i inne aktywa, ustawi krzywą utraty wartości auta i przygotuje polecenia, które uruchomisz w swoim terminalu. Dane pobiera przez MCP, więc obowiązuje poziom prywatności tego profilu.",
  skillHint: "Kroki powyżej odświeżą się same, gdy skill zapisze pozycje w aplikacji.",
  tabs: [{ id: "list", label: "Majątek", render: (ctx) => <Assets accounts={ctx.networth.accounts} /> }],
  Facts: ({ ctx }) => {
    const items = ctx.networth.accounts.filter(isAsset).sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
    const last = items.map((a) => a.as_of).filter(Boolean).sort().slice(-1)[0];
    return (
      <FactList facts={[
        ...items.slice(0, 2).map((a) => [a.name, cur(a.balance, a.currency)] as [string, string]),
        ["Ostatnia wycena", last ?? "-"],
      ]} />
    );
  },
};
