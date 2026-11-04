import { Button } from "@cashu/ui";
import { B } from "./Banking.strings.js";
import type { useBankingScreen } from "./useBankingScreen.js";

const control =
  "rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent";

export interface BankingScreenState {
  readonly screen: ReturnType<typeof useBankingScreen>;
  readonly available: boolean;
  readonly appId: string;
  readonly setAppId: (value: string) => void;
  readonly aspsp: string;
  readonly setAspsp: (value: string) => void;
  readonly callbackUrl: string;
  readonly setCallbackUrl: (value: string) => void;
}

/** Pure profile-local view. The native bridge and state live in BankingScreen. */
export function BankingView({
  state,
  language,
}: {
  readonly state: BankingScreenState;
  readonly language: "pl" | "en";
}) {
  const { screen, appId, setAppId, aspsp, setAspsp, callbackUrl, setCallbackUrl } = state;
  const t = (key: keyof typeof B) => B[key][language];
  if (!state.available) return <p role="status">{t("unavailable")}</p>;
  return (
    <section aria-label={t("title")} className="grid max-w-xl gap-5">
      <h2 className="text-headline font-semibold">{t("title")}</h2>
      <p>{t("keyHint")}</p>
      {!screen.configured && (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void screen.configure(appId);
          }}
        >
          <label className="grid gap-1">
            {t("appId")}
            <input
              className={control}
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              autoComplete="off"
              required
              maxLength={128}
            />
          </label>
          <Button type="submit" disabled={screen.busy}>
            {t("chooseKey")}
          </Button>
        </form>
      )}
      {screen.configured && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={screen.busy} onPress={() => void screen.check()}>
              {t("check")}
            </Button>
            <Button type="button" disabled={screen.busy} onPress={() => void screen.loadBanks()}>
              {t("banks")}
            </Button>
          </div>
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void screen.begin(aspsp);
            }}
          >
            <label className="grid gap-1">
              {t("bank")}
              <input
                className={control}
                list="banking-institutions"
                value={aspsp}
                onChange={(event) => setAspsp(event.target.value)}
                required
                maxLength={256}
                autoComplete="off"
              />
            </label>
            <datalist id="banking-institutions">
              {screen.institutions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <Button type="submit" disabled={screen.busy}>
              {t("consent")}
            </Button>
          </form>
          {screen.pendingUrl && (
            <div className="grid gap-2" role="status">
              <p>{t("waiting")}</p>
              <Button type="button" onPress={() => void screen.open()}>
                {t("openBank")}
              </Button>
              <Button type="button" disabled={screen.busy} onPress={() => void screen.cancel()}>
                {t("cancel")}
              </Button>
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const submitted = callbackUrl;
                  setCallbackUrl("");
                  void screen.complete(submitted);
                }}
              >
                <label className="grid gap-1">
                  {t("manual")}
                  <input
                    className={control}
                    type="url"
                    value={callbackUrl}
                    onChange={(event) => setCallbackUrl(event.target.value)}
                    maxLength={4096}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <Button type="submit" disabled={screen.busy}>
                  {t("complete")}
                </Button>
              </form>
            </div>
          )}
          <div className="grid gap-2">
            <h3 className="font-semibold">{t("sessions")}</h3>
            {screen.connected.map((session) => (
              <div key={session.handle} className="rounded-md border border-border p-3">
                <p>{session.institution}</p>
                <p className="text-sm">{t("localForget")}</p>
                <Button
                  type="button"
                  disabled={screen.busy}
                  onPress={() => void screen.forget(session.handle)}
                >
                  {t("forget")}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              disabled={screen.busy || screen.connected.length === 0}
              onPress={() => void screen.sync()}
            >
              {t("sync")}
            </Button>
          </div>
        </>
      )}
      {screen.attemptList.map((attempt) => (
        <div key={attempt.key} role="status" className="grid gap-2">
          <p>
            {t(
              attempt.status === "outcome_unknown"
                ? "unknown"
                : attempt.status === "not_started"
                  ? "notStarted"
                  : attempt.status,
            )}
          </p>
          {attempt.status === "outcome_unknown" && (
            <Button
              type="button"
              disabled={screen.busy}
              onPress={() => void screen.checkAttempt(attempt.key)}
            >
              {t("checkAttempt")}
            </Button>
          )}
        </div>
      ))}
      {screen.busy && <p role="status">{t("busy")}</p>}
      {screen.notice && (
        <p role="status">
          {t(
            screen.notice === "unknown"
              ? "unknown"
              : screen.notice === "refreshed"
                ? "refreshed"
                : "error",
          )}
        </p>
      )}
    </section>
  );
}
