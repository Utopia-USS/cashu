// The phone's controls (W2c2) under jest-expo + React Native Testing Library: every story renders, and each
// control's interaction reaches its callback. The @expo/ui native views are stood in by a local copy of the
// app's mock; gesture handler, worklets and Reanimated run on jest.native-setup.cjs.
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { storyCases } from "./charts/testing/csf.js";
import { Button } from "./controls/Button.js";
import * as buttonStories from "./controls/Button.native.stories.js";
import { CategoryGrid } from "./controls/CategoryGrid.js";
import * as categoryStories from "./controls/CategoryGrid.native.stories.js";
import { applyKeypadKey, Keypad, type KeypadKey } from "./controls/Keypad.js";
import * as keypadStories from "./controls/Keypad.native.stories.js";
import { SearchField } from "./controls/SearchField.js";
import * as searchStories from "./controls/SearchField.native.stories.js";
import { Seg } from "./controls/Seg.js";
import * as segStories from "./controls/Seg.stories.js";
import { ToggleRow } from "./controls/ToggleRow.js";
import * as toggleStories from "./controls/ToggleRow.native.stories.js";
import { PENDING_SHOW_DELAY_MS } from "./controls/usePressPending.js";
import { Icon } from "./icons/Icon.js";
import * as swatchStories from "./lists/Swatch.native.stories.js";
import { SwipeStack, swipeOutcome } from "./lists/SwipeStack.js";
import * as swipeStories from "./lists/SwipeStack.native.stories.js";

jest.mock("@expo/ui", () => require("./testing/expoUiMock.native").default);

const modules = {
  buttonStories,
  categoryStories,
  keypadStories,
  searchStories,
  segStories,
  swatchStories,
  swipeStories,
  toggleStories,
};
describe.each(Object.entries(modules))("%s (native)", (_name, stories) => {
  it.each(storyCases(stories))("%s renders", async (_story, element) => {
    await render(element);
    expect(screen.root).toBeOnTheScreen();
  });
});

describe("Button (native)", () => {
  // Catalog strings in the app; constants here (a raw JSX text child is a lint error on React Native).
  const PLAN = "Plan PLN 1,000";
  const OTHER = "Other amount";
  const MONTH = "Month";
  const SAVE = "Save";
  it("calls onPress with a string child as its accessible name", async () => {
    const onPress = jest.fn();
    await render(
      <Button variant="primary" onPress={onPress}>
        {PLAN}
      </Button>,
    );
    await fireEvent.press(screen.getByRole("button", { name: "Plan PLN 1,000" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("ignores presses while disabled", async () => {
    const onPress = jest.fn();
    await render(
      <Button onPress={onPress} disabled>
        {OTHER}
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Other amount" });
    expect(button).toBeDisabled();
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("names an icon button by its label", async () => {
    const onPress = jest.fn();
    await render(
      <Button variant="icon" label="Add a cash expense" onPress={onPress}>
        <Icon name="plus" size={20} />
      </Button>,
    );
    await fireEvent.press(screen.getByRole("button", { name: "Add a cash expense" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("marks a pressed toggle selected", async () => {
    await render(<Button pressed>{MONTH}</Button>);
    expect(screen.getByRole("button", { name: "Month" })).toBeSelected();
  });

  it("blocks presses and shows a spinner while a returned promise runs", async () => {
    const spinners = () =>
      JSON.stringify(screen.toJSON()).split('"type":"ActivityIndicator"').length - 1;
    let finish = () => {};
    const onPress = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render(
      <Button variant="primary" onPress={onPress}>
        {SAVE}
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    await fireEvent.press(button);
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Save" })).toBeBusy();
    expect(spinners()).toBe(0);
    // The spinner appears only after the short delay (a fast action never blinks).
    await act(() => new Promise((resolve) => setTimeout(resolve, PENDING_SHOW_DELAY_MS + 50)));
    expect(spinners()).toBe(1);
    await act(async () => finish());
    expect(screen.getByRole("button", { name: "Save" })).not.toBeBusy();
  });
});

describe("Seg", () => {
  const items = [
    ["1M", "1m"],
    ["1Y", "1y"],
    ["Max", "max"],
  ] as const;

  it("calls onChange with the tapped segment and marks the selected one", async () => {
    const onChange = jest.fn();
    await render(<Seg label="Range" items={items} value="1y" onChange={onChange} />);
    // The track is a tablist container (not itself an accessibility element, so not a `getByRole` hit).
    expect(screen.getByLabelText("Range")).toHaveProp("accessibilityRole", "tablist");
    expect(screen.getByRole("tab", { name: "1Y" })).toBeSelected();
    expect(screen.getByRole("tab", { name: "Max" })).not.toBeSelected();
    await fireEvent.press(screen.getByRole("tab", { name: "1M" }));
    expect(onChange).toHaveBeenCalledWith("1m");
  });

  it("ignores taps while disabled", async () => {
    const onChange = jest.fn();
    await render(<Seg label="Range" items={items} value="1y" onChange={onChange} disabled />);
    await fireEvent.press(screen.getByRole("tab", { name: "1M" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "1M" })).toBeDisabled();
  });
});

describe("CategoryGrid", () => {
  const options = categoryStories.default.args.options;
  const grid = (props: Partial<Parameters<typeof CategoryGrid>[0]> = {}) => (
    <CategoryGrid
      options={options}
      selected={null}
      expanded={false}
      onPick={() => {}}
      onExpand={() => {}}
      expandLabel="All categories"
      {...props}
    />
  );

  it("shows the first five options and the expand cell while collapsed", async () => {
    const onExpand = jest.fn();
    await render(grid({ onExpand }));
    expect(screen.getAllByRole("button")).toHaveLength(6);
    expect(screen.queryByText("Fun")).toBeNull();
    const expand = screen.getByRole("button", { name: "All categories" });
    expect(expand).not.toBeExpanded();
    await fireEvent.press(expand);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("shows every option and no expand cell when expanded", async () => {
    await render(grid({ expanded: true }));
    expect(screen.getAllByRole("button")).toHaveLength(options.length);
    expect(screen.queryByText("All categories")).toBeNull();
  });

  it("honours collapsedCount and skips the expand cell when nothing is hidden", async () => {
    await render(grid({ collapsedCount: 2 }));
    expect(screen.getAllByRole("button")).toHaveLength(3);
    await render(grid({ options: options.slice(0, 3) }));
    expect(screen.queryByText("All categories")).toBeNull();
  });

  it("calls onPick with the tapped key", async () => {
    const onPick = jest.fn();
    await render(grid({ onPick }));
    await fireEvent.press(screen.getByRole("button", { name: "Transport" }));
    expect(onPick).toHaveBeenCalledWith("transport");
  });

  it("exposes the selected state and the suggestion hint", async () => {
    await render(grid({ selected: "groceries", suggested: "home", suggestedHint: "Suggested" }));
    expect(screen.getByRole("button", { name: "Groceries" })).toBeSelected();
    expect(screen.getByRole("button", { name: "Home" })).not.toBeSelected();
    expect(screen.getByRole("button", { name: "Home" }).props.accessibilityHint).toBe("Suggested");
    expect(
      screen.getByRole("button", { name: "Groceries" }).props.accessibilityHint,
    ).toBeUndefined();
  });
});

describe("CategoryGrid columns", () => {
  it("lays cells out in halves with columns 2 and keeps the expand label as given", async () => {
    await render(
      <CategoryGrid
        options={categoryStories.default.args.options}
        selected={null}
        expanded={false}
        onPick={() => {}}
        onExpand={() => {}}
        expandLabel="More"
        columns={2}
      />,
    );
    expect(screen.getByText("More")).toBeOnTheScreen();
    const cell = screen.getByRole("button", { name: "Groceries" }).parent;
    expect(String(cell?.props.className)).toContain("w-1/2");
  });
});

describe("applyKeypadKey", () => {
  it.each<[string, KeypadKey, string]>([
    ["", "backspace", ""],
    ["12.5", "backspace", "12."],
    ["12.", "backspace", "12"],
    ["", ".", "0."],
    ["3", ".", "3."],
    ["3.", ".", "3."],
    ["3.4", ".", "3.4"],
    ["0", ".", "0."],
    ["", "5", "5"],
    ["", "0", "0"],
    ["0", "0", "0"],
    ["0", "7", "7"],
    ["10", "0", "100"],
    ["0.", "0", "0.0"],
    ["1.2", "3", "1.23"],
    ["1.23", "4", "1.23"],
    ["0.00", "1", "0.00"],
  ])("%j + %s = %j", (current, key, next) => {
    expect(applyKeypadKey(current, key)).toBe(next);
  });

  it("takes the decimal limit as a parameter", () => {
    expect(applyKeypadKey("1.23", "4", 3)).toBe("1.234");
    expect(applyKeypadKey("1.234", "5", 3)).toBe("1.234");
    expect(applyKeypadKey("12", ".", 0)).toBe("12");
    expect(applyKeypadKey("12", "3", 0)).toBe("123");
  });

  it("types the prototype's sequence", () => {
    const keys: KeypadKey[] = ["0", "0", "4", "5", ".", ".", "9", "9", "9", "backspace"];
    expect(keys.reduce((amount, key) => applyKeypadKey(amount, key), "")).toBe("45.9");
  });

  it("keeps every amount well formed for every sequence of up to four keys", () => {
    const all: KeypadKey[] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "backspace"];
    const wellFormed = /^$|^(0|[1-9]\d*)(\.\d{0,2})?$/;
    let level = [""];
    for (let depth = 0; depth < 4; depth += 1) {
      level = level.flatMap((amount) => all.map((key) => applyKeypadKey(amount, key)));
      for (const amount of level) expect(amount).toMatch(wellFormed);
    }
  });
});

describe("Keypad", () => {
  it("reports every key it shows", async () => {
    const onKey = jest.fn();
    await render(<Keypad onKey={onKey} decimalLabel="," backspaceLabel="Delete" />);
    for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]) {
      await fireEvent.press(screen.getByRole("button", { name: digit }));
    }
    await fireEvent.press(screen.getByRole("button", { name: "," }));
    await fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    expect(onKey.mock.calls.map(([key]) => key)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0",
      ".",
      "backspace",
    ]);
  });
});

describe("SearchField", () => {
  it("reports typed text and clears", async () => {
    const onChange = jest.fn();
    const onClear = jest.fn();
    const field = (value: string) => (
      <SearchField
        value={value}
        placeholder="Search payments"
        onChange={onChange}
        onClear={onClear}
        clearLabel="Clear search"
      />
    );
    await render(field(""));
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    await fireEvent.changeText(screen.getByLabelText("Search payments"), "warta");
    expect(onChange).toHaveBeenCalledWith("warta");
    await screen.rerender(field("warta"));
    await fireEvent.press(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe("ToggleRow", () => {
  it("reports a switch change and the accessibility activate", async () => {
    const onChange = jest.fn();
    await render(<ToggleRow label="Hide amounts" value={false} onChange={onChange} />);
    await fireEvent(screen.getByTestId("expo-ui-switch"), "valueChange", true);
    expect(onChange).toHaveBeenLastCalledWith(true);
    const row = screen.getByRole("switch", { name: "Hide amounts" });
    expect(row).not.toBeChecked();
    await fireEvent(row, "accessibilityAction", { nativeEvent: { actionName: "activate" } });
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("renders a fixed row on, disabled and unchangeable", async () => {
    const onChange = jest.fn();
    await render(<ToggleRow label="Reminder" value={false} onChange={onChange} fixed />);
    const native = screen.getByTestId("expo-ui-switch");
    expect(native.props.value).toBe(true);
    expect(native.props.accessibilityState.disabled).toBe(true);
    const row = screen.getByRole("switch", { name: "Reminder" });
    expect(row).toBeDisabled();
    expect(row).toBeChecked();
    await fireEvent(native, "valueChange", false);
    await fireEvent(row, "accessibilityAction", { nativeEvent: { actionName: "activate" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ToggleRow disabled", () => {
  it("shows its value dimmed and ignores changes until enabled", async () => {
    const onChange = jest.fn();
    await render(<ToggleRow label="Rule" value={false} onChange={onChange} disabled />);
    const native = screen.getByTestId("expo-ui-switch");
    expect(native.props.value).toBe(false);
    const row = screen.getByRole("switch", { name: "Rule" });
    expect(row).toBeDisabled();
    expect(row).not.toBeChecked();
    await fireEvent(native, "valueChange", true);
    await fireEvent(row, "accessibilityAction", { nativeEvent: { actionName: "activate" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("swipeOutcome", () => {
  it.each([
    [121, 0, false, "right"],
    [-121, 0, false, "left"],
    [120, 0, false, null],
    [-40, 0, false, null],
    // A fling leaves even after a short drag, and its direction wins over the drag's.
    [20, 900, false, "right"],
    [30, -900, false, "left"],
    [-200, 900, false, "right"],
    [800, 0, true, null],
    [10, 2000, true, null],
  ] as const)(
    "drag %d, velocity %d, canceled %s -> %s",
    (translationX, velocityX, canceled, out) => {
      expect(swipeOutcome(translationX, velocityX, canceled)).toBe(out);
    },
  );
});

describe("SwipeStack", () => {
  const stack = (onSwiped: (direction: "left" | "right") => void, enabled = true) => (
    <GestureHandlerRootView>
      <SwipeStack
        behind={swipeStories.default.args.behind}
        onSwiped={onSwiped}
        enabled={enabled}
        swipeLeftLabel="Come back to this"
        swipeRightLabel="Next"
      >
        {swipeStories.default.args.children}
      </SwipeStack>
    </GestureHandlerRootView>
  );

  it("renders the top card and the next one behind it", async () => {
    await render(stack(() => {}));
    expect(screen.getByText("Farmers market")).toBeOnTheScreen();
    expect(screen.getByText("Insurance", { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it("swipes through the accessibility actions", async () => {
    const onSwiped = jest.fn();
    await render(stack(onSwiped));
    const top = screen.getByText("Farmers market");
    await fireEvent(top, "accessibilityAction", { nativeEvent: { actionName: "swipeRight" } });
    expect(onSwiped).toHaveBeenLastCalledWith("right");
    await fireEvent(top, "accessibilityAction", { nativeEvent: { actionName: "swipeLeft" } });
    expect(onSwiped).toHaveBeenLastCalledWith("left");
  });

  it("offers no swipe while disabled", async () => {
    const onSwiped = jest.fn();
    await render(stack(onSwiped, false));
    await fireEvent(screen.getByText("Farmers market"), "accessibilityAction", {
      nativeEvent: { actionName: "swipeRight" },
    });
    expect(onSwiped).not.toHaveBeenCalled();
  });
});
