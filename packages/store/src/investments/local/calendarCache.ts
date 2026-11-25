/** Device-local calendar feed cache, usable as the market CalendarCacheStore port. */
import type { market } from "@cashu/domain/investments";
import type { SqlDriver } from "../../sql/driver.js";

export class SqlCalendarCache {
  private readonly driver: SqlDriver;
  private readonly listeners = new Set<() => void>();
  constructor(driver: SqlDriver) {
    this.driver = driver;
    driver.exec(`CREATE TABLE IF NOT EXISTS local_market_calendar (
      id INTEGER PRIMARY KEY CHECK(id=1), content BLOB NOT NULL
    )`);
  }

  /** Preserve the original Python cache bytes, including unknown feed fields and whitespace. */
  restoreBytes(bytes: Uint8Array): void {
    this.driver
      .prepare(
        "INSERT INTO local_market_calendar(id,content) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content",
      )
      .run(Uint8Array.from(bytes));
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  rawBytes(): Uint8Array | null {
    const row = this.driver
      .prepare("SELECT content FROM local_market_calendar WHERE id=1")
      .get<{ content: Uint8Array }>();
    return row ? Uint8Array.from(row.content) : null;
  }

  async read(): Promise<unknown> {
    const bytes = this.rawBytes();
    if (!bytes) return null;
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  async write(data: market.CalendarFeeds): Promise<void> {
    this.restoreBytes(new TextEncoder().encode(JSON.stringify(data)));
  }
}
