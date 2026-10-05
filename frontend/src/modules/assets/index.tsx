import type { ModuleCtx, ModuleDef } from "../../core/types";
import { cur } from "../../format";
import { FactList } from "../../ui";
import { Widget } from "../../widgets";
import { Assets, isAsset } from "./Assets";

const TYPE_HINT: Record<string, string> = { property: "wycena ręczna", vehicle: "krzywa utraty wartości", other: "wycena ręczna" };
const dm = (iso: string | null) => (iso ? `${Number(iso.slice(8, 10))}.${iso.slice(5, 7)}` : "");

/** Przegląd v2: manually valued assets as compact rows. */
function AssetsWidget({ ctx }: { ctx: ModuleCtx }) {
  const items = ctx.networth.accounts.filter(isAsset).sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
  return (
    <Widget title="Majątek" count={items.length > 2 ? items.length : undefined}
      controls={<button className="lnk" onClick={() => ctx.go({ kind: "tab", tab: "assets.list" })}>Majątek</button>}
      body="flush tight">
      {!items.length ? <div className="empty">Brak pozycji majątku.</div> : (
        <table>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td><span className="nm">{a.name}</span><span className="sym">{TYPE_HINT[a.type] ?? "wycena ręczna"} {dm(a.as_of)}</span></td>
                <td className="num">{cur(a.balance, a.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Widget>
  );
}

export const assets: ModuleDef = {
  id: "assets",
  name: "Majątek",
  desc: "Nieruchomości, auta i inne aktywa wyceniane ręcznie",
  short: "Nieruchomości, auta i inne aktywa wyceniane ręcznie",
  tabs: [{ id: "list", label: "Majątek", render: (ctx) => <Assets accounts={ctx.networth.accounts} /> }],
  overview: [{ id: "list", span: 1, order: 60, stack: "side", Widget: AssetsWidget }],
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
