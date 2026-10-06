// The narrow "Agent AI" widget of the first-steps pages (investments, budget, loans, assets setup view): what the
// agent sees at the profile's privacy level, `Ustawienia` -> Ustawienia › Agent AI (design/v3/first-steps 13).
import { Widget } from "../widgets";
import { useShell } from "./context";
import { PRIVACY_PLAIN } from "./SetupPage";

export function AgentWidget() {
  const { profile, go } = useShell();
  return (
    <Widget title="Agent AI" body="tight" footer={<button className="lnk" onClick={() => go({ kind: "settings", section: "agent" })}>Ustawienia</button>}>
      <div style={{ fontSize: 13 }}>{PRIVACY_PLAIN[profile.mcp_privacy] ?? PRIVACY_PLAIN.strict}</div>
    </Widget>
  );
}
