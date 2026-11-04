import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Card } from "./Card.js";

afterEach(cleanup);
const body = "Body";
const next = "Next";

it("renders the chosen landmark with its name, role and test id", () => {
  render(
    <>
      <Card label="Expenses" testID="expenses">
        {body}
      </Card>
      <Card as="nav" label="Files">
        {body}
      </Card>
      <Card as="p" role="status">
        {body}
      </Card>
    </>,
  );
  expect(screen.getByRole("region", { name: "Expenses" }).dataset.testid).toBe("expenses");
  expect(screen.getByRole("navigation", { name: "Files" })).toBeTruthy();
  expect(screen.getByRole("status").tagName).toBe("P");
});

it("submits as a form", () => {
  const submit = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
  render(
    <Card as="form" label="Profile" onSubmit={submit}>
      <button type="submit">{next}</button>
    </Card>,
  );
  fireEvent.click(screen.getByRole("button", { name: next }));
  expect(submit).toHaveBeenCalledOnce();
});
