import { BankingScreen } from "./BankingScreen.js";
import type { BankingReply, BankingUiPort } from "./useBankingScreen.js";

/** Synthetic owner bridge, with no bank/network/keyring access. */
export function syntheticBankingPort(initiallyConfigured = false): BankingUiPort {
  let configured = initiallyConfigured;
  let connected = initiallyConfigured;
  let pendingConsent: string | null = null;
  let pendingAttempts: { key: string; command: "banking.importAccount" }[] = [];
  /** The bank's answer the waiting completeConsent gets: a pasted URL or a cancel. */
  let answer: ((reply: BankingReply) => void) | null = null;
  return {
    async invoke(action) {
      switch (action.type) {
        case "status":
          return {
            ok: true,
            value: {
              configured,
              application: configured ? "2e79b1c2-0000-4000-8000-000000000000" : null,
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
        case "unconfigure":
          configured = false;
          connected = false;
          pendingConsent = null;
          return { ok: true, value: { removed: true } };
        case "check":
          return { ok: true, value: { ok: true, application: { name: "Synthetic app" } } };
        case "banks":
          return { ok: true, value: [{ name: "Synthetic Bank", country: "PL" }] };
        case "beginConsent":
          pendingConsent = "https://synthetic-bank.example/authorize";
          return { ok: true, value: { url: pendingConsent } };
        case "cancelConsent":
          pendingConsent = null;
          answer?.({ ok: false, error: "consent_cancelled" });
          return { ok: true, value: { cancelled: true } };
        case "offerCallback":
          if (!answer) return { ok: false, error: "consent_cancelled" };
          connected = true;
          pendingConsent = null;
          answer({
            ok: true,
            value: { institution: "synthetic", accounts: 1, inserted: 1, attempts: [] },
          });
          return { ok: true, value: { accepted: true } };
        case "completeConsent":
          // Waits like the host: until the bank answers (here: a pasted URL) or a cancel.
          return new Promise<BankingReply>((resolve) => {
            answer = (reply) => {
              answer = null;
              resolve(reply);
            };
          });
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
