import { useState } from "react";
import { BankingView } from "./BankingView.js";
import { type BankingUiPort, useBankingScreen } from "./useBankingScreen.js";

/** Keyed profile boundary clears form fields and invalidates old async responses on vault switch. */
export function BankingScreen(props: {
  readonly vaultId: string;
  readonly port: BankingUiPort | null;
  readonly language: "pl" | "en";
}) {
  return <ProfileBankingScreen key={props.vaultId} {...props} />;
}

function ProfileBankingScreen({
  vaultId,
  port,
  language,
}: {
  readonly vaultId: string;
  readonly port: BankingUiPort | null;
  readonly language: "pl" | "en";
}) {
  const screen = useBankingScreen(port, vaultId);
  const [appId, setAppId] = useState("");
  const [aspsp, setAspsp] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Only a name from Enable Banking's own list is ever sent.
  const chosen = screen.institutions.includes(aspsp) ? aspsp : "";
  return (
    <BankingView
      language={language}
      state={{
        screen,
        available: port !== null,
        appId,
        setAppId,
        aspsp,
        setAspsp,
        callbackUrl,
        setCallbackUrl,
        dragging,
        setDragging,
        chosen,
        confirmRemove,
        setConfirmRemove,
      }}
    />
  );
}
