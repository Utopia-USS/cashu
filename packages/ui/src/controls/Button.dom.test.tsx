import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "./Button.js";

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
