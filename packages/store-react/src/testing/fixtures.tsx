// Queries, commands and components the binding tests share. Synthetic data only.
import { defineCommand, renameProfile } from "@cashu/store";
import { defineQuery } from "@cashu/store/query";
import { Component, type ReactNode, useEffect } from "react";
import { z } from "zod";
import { useCommand } from "../react/useCommand.js";
import { useQuery } from "../react/useQuery.js";

export const profileName = defineQuery({
  id: "test.profileName",
  run: (read) => read<{ name: string }>("SELECT name FROM profiles")[0]?.name ?? null,
});

export const accountRows = defineQuery({
  id: "test.accountRows",
  run: (read) => read<{ gid: string; name: string }>("SELECT gid, name FROM accounts ORDER BY id"),
});

export const accountGids = defineQuery({
  id: "test.accountGids",
  run: (read) => read<{ gid: string }>("SELECT gid FROM accounts ORDER BY id").map((r) => r.gid),
});

/** Fails once the profile is renamed to "Zła" (a decoding bug stand-in). */
export const fragileName = defineQuery({
  id: "test.fragileName",
  run: (read) => {
    const name = read<{ name: string }>("SELECT name FROM profiles")[0]?.name ?? null;
    if (name === "Zła") throw new Error("cannot decode the profile");
    return name;
  },
});

/** A command with a bug: it throws instead of returning a refusal. */
export const explode = defineCommand({
  id: "test.explode",
  input: z.object({}),
  run: () => {
    throw new Error("command bug");
  },
});

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) return <p role="alert">{`boundary: ${this.state.error.message}`}</p>;
    return this.props.children;
  }
}

/** Mounts of `Fallback`: one per time a Suspense boundary went from content (or nothing) to loading. */
export const fallbackMounts = { count: 0 };

export function Fallback() {
  useEffect(() => {
    fallbackMounts.count += 1;
  }, []);
  return <p>loading</p>;
}

/** A button running the buggy command. */
export function Bomb() {
  const { run } = useCommand(explode);
  return (
    <button type="button" onClick={() => void run({})}>
      go
    </button>
  );
}

/** Shows `fragileName`; its button renames the profile so that the query fails. */
export function Fragile() {
  const name = useQuery(fragileName);
  const { run } = useCommand(renameProfile);
  return (
    <button type="button" onClick={() => void run({ name: "Zła" })}>
      {name}
    </button>
  );
}
