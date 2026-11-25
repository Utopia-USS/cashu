// The app's own system prompts (a permission it asks for): iOS makes the app `inactive` while the prompt is
// up, which the app-switcher cover (`PrivacyCover`) would take for the switcher and blank the screen behind
// the prompt. While this app itself asks, `inactive` is expected and the cover stays away; the expectation
// ends with the answer or after `PROMPT_EXPECTED_MS`, and `background` (a real app switch) always covers.
/** The longest a prompt counts as expected (an unanswered prompt left up must not disable the cover). */
export const PROMPT_EXPECTED_MS = 60_000;

const open = new Set<symbol>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export const systemPrompt = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** A prompt of this app is up (asked and not yet answered, within the bound). */
  expected(): boolean {
    return open.size > 0;
  },
  /** The app asks the system now; call the returned function on the answer (it is idempotent). */
  expect(): () => void {
    const token = Symbol("prompt");
    open.add(token);
    emit();
    const end = () => {
      clearTimeout(timer);
      if (open.delete(token)) emit();
    };
    const timer = setTimeout(end, PROMPT_EXPECTED_MS);
    return end;
  },
};

/** Whether the app-switcher cover hides the app (pure), from `AppState.currentState`. */
export function coversApp(state: string | null | undefined, promptExpected: boolean): boolean {
  if (state === "active" || state === "unknown") return false;
  return !(state === "inactive" && promptExpected);
}
