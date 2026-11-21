// The app's own system prompts: the expectation ends on the answer or after its bound (the cover itself is
// tested in shell.native.test.tsx).
import { PROMPT_EXPECTED_MS, systemPrompt } from "./systemPrompt";

afterEach(() => jest.useRealTimers());

it("expects the prompt until it is answered, at most for its bound", () => {
  jest.useFakeTimers();
  const answered = systemPrompt.expect();
  expect(systemPrompt.expected()).toBe(true);
  answered();
  expect(systemPrompt.expected()).toBe(false);
  systemPrompt.expect();
  jest.advanceTimersByTime(PROMPT_EXPECTED_MS - 1);
  expect(systemPrompt.expected()).toBe(true);
  jest.advanceTimersByTime(1);
  expect(systemPrompt.expected()).toBe(false);
});
