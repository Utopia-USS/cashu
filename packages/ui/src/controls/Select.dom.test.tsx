import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Select } from "./Select.js";

afterEach(cleanup);
const options = [
  { value: "PLN", label: "PLN" },
  { value: "EUR", label: "EUR" },
  { value: "CHF", label: "CHF", disabled: true },
];

it("renders the options, reports the picked value and keeps the accessible name", () => {
  const change = vi.fn();
  render(<Select label="Currency" value="PLN" onChange={change} options={options} />);
  const picker = screen.getByRole("combobox", { name: "Currency" }) as HTMLSelectElement;
  expect(picker.value).toBe("PLN");
  expect([...picker.options].map((o) => [o.value, o.disabled])).toEqual([
    ["PLN", false],
    ["EUR", false],
    ["CHF", true],
  ]);
  fireEvent.change(picker, { target: { value: "EUR" } });
  expect(change).toHaveBeenCalledWith("EUR");
});

it("names the picker without a visible label and disables it", () => {
  render(
    <Select
      label="Currency"
      labelHidden
      value="PLN"
      onChange={() => {}}
      options={options}
      disabled
    />,
  );
  expect(screen.queryByText("Currency")).toBeNull();
  expect((screen.getByRole("combobox", { name: "Currency" }) as HTMLSelectElement).disabled).toBe(
    true,
  );
});
