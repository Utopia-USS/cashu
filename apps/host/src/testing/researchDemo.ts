/** Synthetic Research acceptance data. Called only by the guarded Electron demo setup. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addDays, type IsoDate } from "@cashu/domain";
import { market } from "@cashu/domain/investments";
import type * as macro from "@cashu/domain/investments/macro";
import { investmentsCommands, investmentsResearch, runCommand } from "@cashu/store";
import type { ResearchScreenCapability } from "../researchScreen.js";
import type { OpenVault } from "../stores.js";

async function command<I, R>(
  vault: OpenVault,
  cmd: Parameters<typeof runCommand<I, R>>[2],
  input: unknown,
): Promise<R> {
  const result = await vault.queue.run(() =>
    runCommand(vault.store, vault.writer, cmd, input, vault.env),
  );
  if (!result.ok) throw new Error(`synthetic research command refused: ${result.reason}`);
  return result.value;
}

function note(n: number, published: string, changes: Record<string, unknown> = {}) {
  return {
    kind: "news",
    polarity: "negative",
    strength: 2,
    title: `Synthetic research fact ${n}`,
    summary: `Synthetic source ${n} describes a distinct observed change for the acceptance fixture.`,
    sources: [
      {
        url: `https://example.test/research/${n}`,
        publisher: "Synthetic publisher",
        published_at: published,
      },
    ],
    ...changes,
  };
}

export async function seedResearchDemo(
  vault: OpenVault,
): Promise<{ instrument: string; symbol: string | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const held = investmentsResearch.heldInstrumentGids(vault.store.read.bind(vault.store), today);
  const eligible = vault.store.read<{
    gid: string;
    symbol: string | null;
    mic: string | null;
  }>("SELECT gid, symbol, mic FROM inv_instruments ORDER BY id");
  const calendarSymbol = (row: (typeof eligible)[number]) =>
    market.usSymbol({
      id: row.gid,
      name: "",
      symbol: row.symbol,
      mic: row.mic,
      label: "",
      yahoo: null,
      held: true,
    });
  const heldInstrument =
    eligible.find((row) => held.has(row.gid) && calendarSymbol(row))?.gid ?? [...held][0];
  const selected =
    heldInstrument !== undefined
      ? vault.store.read<{ gid: string; symbol: string | null }>(
          "SELECT gid, symbol FROM inv_instruments WHERE gid = ?",
          heldInstrument,
        )[0]
      : vault.store.read<{ gid: string; symbol: string | null }>(
          "SELECT gid, symbol FROM inv_instruments ORDER BY id LIMIT 1",
        )[0];
  const instrument = selected?.gid;
  if (selected === undefined || instrument === undefined)
    throw new Error("synthetic research instrument is absent");
  const started = await command(vault, investmentsResearch.startResearchRun, {
    scope: { instruments: [instrument], themes: ["Energy"], scheduled: true },
    createdBy: "agent",
  });
  await command(vault, investmentsResearch.addResearchNote, {
    note: note(1, today, { theme: "Energy" }),
    instrument,
    run: started.run,
    createdBy: "agent",
  });
  await command(vault, investmentsResearch.addResearchNote, {
    note: note(2, today, { theme: "Energy", strength: 1 }),
    instrument: null,
    run: started.run,
    createdBy: "agent",
  });
  await command(vault, investmentsResearch.finishResearchRun, {
    run: started.run,
    status: "done",
    counts: { sources_checked: 2 },
  });
  await command(vault, investmentsResearch.addResearchNote, {
    note: note(3, today, {
      kind: "candidate",
      polarity: "positive",
      candidate: { symbol_or_isin: "SYNTH.WA", name: "Synthetic Candidate" },
      details: { entry_type: "trend", criteria: [{ text: "Synthetic criterion", met: true }] },
    }),
    instrument: null,
    createdBy: "agent",
  });
  const resolvedCandidate = await command(vault, investmentsCommands.createInstrument, {
    name: "Synthetic Resolved Candidate",
    currency: "USD",
    assetClass: "equity",
    symbol: "SYNTHC",
    isin: null,
    mic: "XNAS",
    region: "US",
    sector: null,
  });
  await command(vault, investmentsCommands.setInstrumentSegment, {
    instrument: resolvedCandidate.gid,
    segment: "equity_global",
    by: "owner",
  });
  await command(vault, investmentsResearch.addResearchNote, {
    note: note(4, today, {
      kind: "candidate",
      polarity: "positive",
      details: {
        entry_type: "trend",
        criteria: [{ text: "Synthetic resolved criterion", met: true }],
      },
    }),
    instrument: resolvedCandidate.gid,
    createdBy: "agent",
  });
  // An agent draft for the topic the resolved candidate belongs to; the owner confirms or edits it.
  await command(vault, investmentsResearch.proposeTopicDraft, {
    segment: "equity_global",
    thesis: "Synthetic agent topic draft",
    invalidation: "Synthetic topic invalidation",
  });
  const archivedDay = addDays(today, -1);
  for (let number = 100; number < 155; number++) {
    await command(vault, investmentsResearch.addResearchNote, {
      note: note(number, archivedDay, { observed_at: `${archivedDay}T08:00:00Z` }),
      instrument,
      createdBy: "user",
    });
  }
  const selectedForCalendar = eligible.find((row) => row.gid === instrument);
  return {
    instrument,
    symbol: selectedForCalendar ? calendarSymbol(selectedForCalendar) : null,
  };
}

/** Versioned, typed synthetic market and checked workspace facts for the Electron test only. */
export function syntheticResearchCapability(
  vault: string,
  generation: string,
  isCurrent: () => boolean,
  workspacePath: string,
  heldSymbol: string | null,
): ResearchScreenCapability {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const sessions: IsoDate[] = [];
  for (let offset = 419; offset >= 0; offset--) {
    const day = new Date(now);
    day.setUTCDate(now.getUTCDate() - offset);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
      sessions.push(day.toISOString().slice(0, 10) as IsoDate);
  }
  const closes: macro.MacroCloses = {
    acwi: sessions.map((day, index) => [day, 100 + index * 0.1] as const),
    spx: sessions.map((day, index) => [day, 5000 + index * 2] as const),
    dxy: sessions.map((day) => [day, 100] as const),
    eem: sessions.map((day, index) => [day, 50 + index * 0.05] as const),
    dbc: sessions.map((day) => [day, 20] as const),
    us10y: sessions.map((day) => [day, 4.5] as const),
    us3m: sessions.map((day) => [day, 4.0] as const),
  };
  const feeds: market.CalendarFeeds = {
    fetched_at: now.toISOString(),
    from: today,
    to: addDays(today, 14),
    macro: [
      {
        date: addDays(today, 2),
        time: "14:30",
        country: "US",
        title: "CPI inflation",
        source_title: "CPI inflation",
      },
    ],
    earnings:
      heldSymbol === null
        ? []
        : [
            {
              date: addDays(today, 4),
              symbol: heldSymbol,
              name: "Synthetic earnings",
              when: "pre",
            },
          ],
    errors: [],
  };
  const exists = existsSync(workspacePath);
  const skillInstalled = existsSync(
    join(workspacePath, ".agents", "skills", "market-research", "SKILL.md"),
  );
  return {
    vault,
    generation,
    isCurrent,
    macro: { revision: randomUUID(), closes },
    calendar: { revision: randomUUID(), feeds },
    workspace: {
      revision: randomUUID(),
      info: {
        path: exists ? workspacePath : null,
        exists,
        skillInstalled,
        command: null,
        routine: null,
      },
    },
  };
}
