import { S as A } from "@cashu/i18n/core/chrome.strings";
import { S as P } from "@cashu/i18n/core/SetupPage.strings";
import { Button } from "../controls/Button.js";
import { Widget } from "./Widget.js";

export interface PrivacyLineProps {
  /** The profile's MCP privacy level; anything but `amounts` reads as strict. */
  privacy: string;
}

/** What the agent sees at the profile's privacy level (old SetupPage `PRIVACY_PLAIN`): a bold level, then the
 * plain sentence. */
export function PrivacyLine({ privacy }: PrivacyLineProps) {
  return privacy === "amounts" ? (
    <>
      <b>{P.amountsBold}</b>
      {P.amountsText}
    </>
  ) : (
    <>
      <b>{P.strictBold}</b>
      {P.strictText}
    </>
  );
}

export interface AgentWidgetProps extends PrivacyLineProps {
  /** `Ustawienia` in the footer: Ustawienia › Agent AI. */
  onSettings(): void;
  /** Layout only. */
  className?: string;
}

/** The narrow `Agent AI` widget of the first-steps pages (old core/AgentWidget.tsx): the privacy line, a
 * `Ustawienia` link in the footer. */
export function AgentWidget({ privacy, onSettings, className }: AgentWidgetProps) {
  return (
    <Widget
      title={A.agent}
      tight
      className={className}
      footer={
        <Button variant="link" size="md" onPress={onSettings}>
          {A.settings}
        </Button>
      }
    >
      <div className="text-sm">
        <PrivacyLine privacy={privacy} />
      </div>
    </Widget>
  );
}
