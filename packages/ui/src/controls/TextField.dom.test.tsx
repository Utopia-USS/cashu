import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TextField } from "./TextField.js";

afterEach(cleanup);
const name = "Name";

it("wraps the control in its visible label, reports the typed value and forwards the ref", () => {
  const change = vi.fn();
  const ref = createRef<HTMLInputElement>();
  render(<TextField ref={ref} label={name} value="a" onChange={change} maxLength={5} />);
  const field = screen.getByRole("textbox", { name });
  expect(ref.current).toBe(field);
  expect(field.parentElement?.tagName).toBe("LABEL");
  expect(field.hasAttribute("aria-label")).toBe(false);
  expect(field.getAttribute("maxlength")).toBe("5");
  fireEvent.change(field, { target: { value: "ab" } });
  expect(change).toHaveBeenCalledWith("ab");
});

it("renders a multi-line field and the invalid, described and disabled states", () => {
  const change = vi.fn();
  render(
    <>
      <TextField
        label="Note"
        labelHidden
        multiline
        rows={3}
        value=""
        onChange={change}
        invalid
        describedBy="hint"
      />
      <TextField label="Locked" value="x" onChange={() => {}} disabled />
    </>,
  );
  const note = screen.getByRole("textbox", { name: "Note" });
  expect(note.tagName).toBe("TEXTAREA");
  expect(note.getAttribute("aria-label")).toBe("Note");
  expect(note.getAttribute("aria-invalid")).toBe("true");
  expect(note.getAttribute("aria-describedby")).toBe("hint");
  fireEvent.change(note, { target: { value: "line" } });
  expect(change).toHaveBeenCalledWith("line");
  expect((screen.getByRole("textbox", { name: "Locked" }) as HTMLInputElement).disabled).toBe(true);
});

it("exposes the combobox role and the password type", () => {
  const { container } = render(
    <>
      <TextField
        label="Search"
        value=""
        onChange={() => {}}
        combobox={{ controls: "results", expanded: false }}
      />
      <TextField label="Key" labelHidden type="password" value="" onChange={() => {}} />
    </>,
  );
  const search = screen.getByRole("combobox", { name: "Search", expanded: false });
  expect(search.getAttribute("aria-controls")).toBe("results");
  expect(container.querySelector('input[type="password"]')?.getAttribute("aria-label")).toBe("Key");
});
