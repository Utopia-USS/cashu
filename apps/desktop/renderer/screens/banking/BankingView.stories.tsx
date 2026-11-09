import { BankingScreen } from "./BankingScreen.js";
import type { BankingUiPort } from "./useBankingScreen.js";

/** Synthetic owner bridge, with no bank/network/keyring access. */
export function syntheticBankingPort(initiallyConfigured = false): BankingUiPort {
  let configured = initiallyConfigured;
  let connected = initiallyConfigured;
  let pendingConsent: string | null = null;
  let pendingAttempts: { key: string; command: "banking.importAccount" }[] = [];
  return {
    async invoke(action) {
      switch (action.type) {
        case "status":
          return {
            ok: true,
            value: {
              configured,
              sessions: connected
                ? [
                    {
                      handle: "a".repeat(64),
                      institution: "Synthetic Bank",
                      lastSyncAt: null,
                      backoffUntil: null,
                    },
                  ]
                : [],
              pendingConsent,
              pendingAttempts,
            },
          };
        case "check":
          return { ok: true, value: { ok: true, application: { name: "Synthetic app" } } };
        case "banks":
          return { ok: true, value: [{ name: "Synthetic Bank", country: "PL" }] };
        case "beginConsent":
          pendingConsent = "https://synthetic-bank.example/authorize";
          return { ok: true, value: { url: pendingConsent } };
        case "cancelConsent":
          pendingConsent = null;
          return { ok: true, value: { cancelled: true } };
        case "completeConsent":
          connected = true;
          pendingConsent = null;
          return {
            ok: true,
            value: { institution: "synthetic", accounts: 1, inserted: 1, attempts: [] },
          };
        case "sync":
          pendingAttempts = [{ key: "b".repeat(32), command: "banking.importAccount" }];
          return {
            ok: true,
            value: {
              accounts: 1,
              inserted: 0,
              attempts: pendingAttempts,
            },
          };
        case "forgetSession":
          connected = false;
          return { ok: true, value: { forgotten: true } };
        case "attemptStatus":
          pendingAttempts = [];
          return { ok: true, value: { status: "completed" } };
      }
    },
    async chooseKeyAndConfigure() {
      configured = true;
      return { ok: true, value: { configured: true } };
    },
    async configureWithDroppedKey() {
      configured = true;
      return { ok: true, value: { configured: true } };
    },
    async openBank() {},
  };
}

const port = syntheticBankingPort(true);
export const Connected = {
  render: () => <BankingScreen vaultId="synthetic-profile" port={port} language="en" />,
};
export const NotConfigured = {
  render: () => (
    <BankingScreen vaultId="synthetic-profile" port={syntheticBankingPort()} language="pl" />
  ),
};
export const Unavailable = {
  render: () => <BankingScreen vaultId="synthetic-profile" port={null} language="pl" />,
};
