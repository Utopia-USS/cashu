import { expect, it } from "vitest";
import { dispatchDesktopEntry } from "./entryDispatch.js";

it("registers early response capture before a delayed ordinary main import", async () => {
  const order: string[] = [];
  let complete = () => {};
  const hold = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const running = dispatchDesktopEntry([], {
    registerAppScheme: () => {
      order.push("scheme");
    },
    registerEarlyResponses: () => {
      order.push("delegate");
    },
    loadMain: async () => {
      order.push("main");
      await hold;
    },
    runHelper: async () => {
      throw new Error("helper must not load");
    },
  });
  expect(order).toEqual(["scheme", "delegate", "main"]);
  complete();
  expect(await running).toBeNull();
});

it("runs only the exact helper mode and rejects malformed helper argv", async () => {
  for (const args of [["--notify-helper"], ["--notify-helper", "extra"]]) {
    const order: string[] = [];
    const code = await dispatchDesktopEntry(args, {
      registerAppScheme: () => {
        order.push("scheme");
      },
      registerEarlyResponses: () => {
        order.push("delegate");
      },
      loadMain: async () => {
        order.push("main");
      },
      runHelper: async () => {
        order.push("helper");
        return 0;
      },
    });
    expect(code).toBe(args.length === 1 ? 0 : 2);
    expect(order).toEqual(args.length === 1 ? ["helper"] : []);
  }
});

it("refuses a positional command (a leftover Python agent or MCP entry) without loading main", async () => {
  for (const args of [["worker", "run"], ["mcp", "--profile", "jan"], ["stats"]]) {
    const order: string[] = [];
    const code = await dispatchDesktopEntry(args, {
      registerAppScheme: () => {
        order.push("scheme");
      },
      registerEarlyResponses: () => {
        order.push("delegate");
      },
      loadMain: async () => {
        order.push("main");
      },
      runHelper: async () => {
        order.push("helper");
        return 0;
      },
      refuseCommand: (command) => {
        order.push(`refused:${command}`);
      },
    });
    expect(code).toBe(64);
    expect(order).toEqual([`refused:${args[0]}`]);
  }
  for (const args of [["--lang=pl-PL"], ["cashu://investments"]])
    expect(
      await dispatchDesktopEntry(args, {
        registerEarlyResponses: () => {},
        loadMain: async () => {},
        runHelper: async () => 0,
      }),
    ).toBeNull();
});
