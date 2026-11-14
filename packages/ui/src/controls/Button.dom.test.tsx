import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "./Button.js";
import { PENDING_MIN_VISIBLE_MS, PENDING_SHOW_DELAY_MS } from "./usePressPending.js";

afterEach(cleanup);
const arrow = "‹";
const preview = "Preview";
const topics = "Topics";
const all = "All categories";
const save = "Save";

it("maps state props to ARIA, forwards the ref and presses", () => {
  const press = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  render(
    <>
      <Button ref={ref} label="Previous month" onPress={press}>
        {arrow}
      </Button>
      <Button pressed>{preview}</Button>
      <Button current="page">{topics}</Button>
      <Button expanded={false} title="Hint">
        {all}
      </Button>
    </>,
  );
  const previous = screen.getByRole("button", { name: "Previous month" });
  expect(ref.current).toBe(previous);
  expect(previous.getAttribute("type")).toBe("button");
  fireEvent.click(previous);
  expect(press).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: preview, pressed: true })).toBeTruthy();
  expect(screen.getByRole("button", { name: topics }).getAttribute("aria-current")).toBe("page");
  const toggle = screen.getByRole("button", { name: all, expanded: false });
  expect(toggle.title).toBe("Hint");
});

it("does not press while disabled", () => {
  const press = vi.fn();
  render(
    <Button disabled onPress={press}>
      {save}
    </Button>,
  );
  fireEvent.click(screen.getByRole("button", { name: save }));
  expect(press).not.toHaveBeenCalled();
});

it("is busy while the press promise runs: blocks presses, shows the spinner late, keeps it briefly", async () => {
  vi.useFakeTimers();
  try {
    let finish: () => void = () => {};
    const press = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<Button onPress={press}>{save}</Button>);
    const button = screen.getByRole("button", { name: save });
    fireEvent.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector("svg")).toBeNull();
    fireEvent.click(button);
    expect(press).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(PENDING_SHOW_DELAY_MS);
    });
    expect(button.querySelector("svg")).not.toBeNull();
    await act(async () => {
      finish();
    });
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.querySelector("svg")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(PENDING_MIN_VISIBLE_MS);
    });
    expect(button.querySelector("svg")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("never shows the spinner for a fast action", async () => {
  vi.useFakeTimers();
  try {
    render(<Button onPress={() => Promise.resolve()}>{save}</Button>);
    const button = screen.getByRole("button", { name: save });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-busy")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(PENDING_SHOW_DELAY_MS * 2);
    });
    expect(button.querySelector("svg")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("takes pending from the caller and keeps its face while disabled siblings fade", () => {
  render(
    <Button pending disabled type="submit">
      {save}
    </Button>,
  );
  const button = screen.getByRole("button", { name: save }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("aria-busy")).toBe("true");
});
