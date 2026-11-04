import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Modal } from "./Modal.js";

afterEach(cleanup);

it("contains keyboard focus, dismisses with Escape, and restores the opener", () => {
  const close = vi.fn();
  const opener = <button type="button" aria-label="Open" />;
  const { rerender } = render(opener);
  screen.getByRole("button", { name: "Open" }).focus();
  rerender(
    <>
      {opener}
      <Modal label="Details" onClose={close}>
        <button type="button" aria-label="First" />
        <button type="button" aria-label="Last" />
      </Modal>
    </>,
  );
  const first = screen.getByRole("button", { name: "First" });
  const last = screen.getByRole("button", { name: "Last" });
  expect(document.activeElement).toBe(first);
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  rerender(opener);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" }));
});

it("dismisses from the backdrop and leaves a nested modal in control of Escape", () => {
  const parentClose = vi.fn();
  const childClose = vi.fn();
  render(
    <>
      <Modal label="Parent" onClose={parentClose}>
        <button type="button" aria-label="Parent action" />
      </Modal>
      <Modal label="Child" onClose={childClose}>
        <button type="button" aria-label="Child action" />
      </Modal>
    </>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Child action" }), { key: "Escape" });
  expect(childClose).toHaveBeenCalledOnce();
  expect(parentClose).not.toHaveBeenCalled();
  const backdrops = document.body.querySelectorAll('[aria-hidden="true"]');
  fireEvent.click(backdrops[1] as Element);
  expect(childClose).toHaveBeenCalledTimes(2);
});

it("skips hidden descendants, disabled controls and negative tab stops", () => {
  render(
    <Modal label="Filtered" onClose={() => {}}>
      <div style={{ display: "none" }}>
        <button type="button" aria-label="CSS hidden" />
      </div>
      <div hidden>
        <button type="button" aria-label="HTML hidden" />
      </div>
      <button type="button" disabled aria-label="Disabled" />
      <button type="button" tabIndex={-2} aria-label="Negative tab" />
      <button type="button" aria-label="Visible" />
    </Modal>,
  );
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Visible" }));
});

it("restores focus into the parent dialog and keeps scroll locked until the last closes", () => {
  const parent = (
    <Modal label="Parent" onClose={() => {}}>
      <button type="button" aria-label="Parent action" />
    </Modal>
  );
  const child = (
    <Modal label="Child" onClose={() => {}}>
      <button type="button" aria-label="Child action" />
    </Modal>
  );
  const { rerender } = render(parent);
  const parentAction = screen.getByRole("button", { name: "Parent action" });
  parentAction.focus();
  rerender(
    <>
      {parent}
      {child}
    </>,
  );
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Child action" }));
  const panels = screen.getAllByRole("dialog", { hidden: true });
  expect(panels[0]?.inert).toBe(true);
  expect((panels[1] as HTMLElement).style.zIndex).toContain("1 * var(--modal-layer-step)");
  const backdrops = document.querySelectorAll<HTMLElement>('[aria-hidden="true"]');
  expect(backdrops[1]?.style.zIndex).toContain("1 * var(--modal-layer-step)");
  expect(document.body.style.overflow).toBe("hidden");
  rerender(parent);
  expect(document.activeElement).toBe(parentAction);
  expect(document.body.style.overflow).toBe("hidden");
  rerender(<div />);
  expect(document.body.style.overflow).toBe("");
});

it("creates one history entry across StrictMode effect replay", async () => {
  const push = vi.spyOn(window.history, "pushState");
  render(
    <StrictMode>
      <Modal label="Strict" onClose={() => {}}>
        <button type="button" aria-label="Action" />
      </Modal>
    </StrictMode>,
  );
  await Promise.resolve();
  expect(push).toHaveBeenCalledOnce();
  push.mockRestore();
});

it("routes browser back to the top modal", async () => {
  const parentClose = vi.fn();
  const childClose = vi.fn();
  render(
    <>
      <Modal label="Parent" onClose={parentClose}>
        <button type="button" aria-label="Parent action" />
      </Modal>
      <Modal label="Child" onClose={childClose}>
        <button type="button" aria-label="Child action" />
      </Modal>
    </>,
  );
  await Promise.resolve();
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(childClose).toHaveBeenCalledOnce();
  expect(parentClose).not.toHaveBeenCalled();
});

it("ports a DOM-nested child outside the inert parent panel", () => {
  render(
    <Modal label="Parent" onClose={() => {}}>
      <button type="button" aria-label="Parent action" />
      <Modal label="Child" onClose={() => {}}>
        <button type="button" aria-label="Child action" />
      </Modal>
    </Modal>,
  );
  const parent = screen.getByRole("dialog", { name: "Parent", hidden: true });
  const child = screen.getByRole("dialog", { name: "Child" });
  expect(parent.inert).toBe(true);
  expect(parent.contains(child)).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Child action" }));
});

it("pushes initially nested modal history parent first so closing the child removes its entry", async () => {
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  const parent = (child: boolean) => (
    <Modal label="Parent" onClose={() => {}}>
      <button type="button" aria-label="Parent action" />
      {child && (
        <Modal label="Child" onClose={() => {}}>
          <button type="button" aria-label="Child action" />
        </Modal>
      )}
    </Modal>
  );
  const { rerender } = render(parent(true));
  try {
    await Promise.resolve();
    rerender(parent(false));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(back).toHaveBeenCalledOnce();
  } finally {
    back.mockRestore();
  }
});

const visibleTitle = "Visible title";
it("names the dialog by a visible heading when labelledBy is given", () => {
  render(
    <Modal label="Fallback" labelledBy="modal-heading" onClose={() => {}}>
      <h2 id="modal-heading">{visibleTitle}</h2>
      <button type="button" aria-label="Action" />
    </Modal>,
  );
  const dialog = screen.getByRole("dialog", { name: "Visible title" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.hasAttribute("aria-label")).toBe(false);
});

it("places the panel by role", () => {
  render(
    <Modal label="Drawer" placement="end" onClose={() => {}}>
      <button type="button" aria-label="Action" />
    </Modal>,
  );
  const panel = screen.getByRole("dialog", { name: "Drawer" });
  expect(panel.className).toContain("right-0");
  expect(panel.className).not.toContain("inset-4");
});
