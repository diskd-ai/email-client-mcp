import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";

const account = {
  name: "work",
  email: "work@example.com",
  password: "secret",
  imap: { host: "imap.example.com", port: 993 },
};

describe("config/schema", () => {
  /* REQUIREMENT end:comm/email-client-mcp/config -- default watcher interval avoids per-minute idle IMAP scans */
  it("defaults watcher interval to 5 minutes", () => {
    const parsed = configSchema.parse({ accounts: [account] });

    expect(parsed.watcher.interval_ms).toBe(300_000);
  });

  /* REQUIREMENT end:comm/email-client-mcp/config -- watcher body hydration has safe eager defaults */
  it("defaults watcher body hydration settings", () => {
    const parsed = configSchema.parse({ accounts: [account] });

    expect(parsed.watcher.body_hydration).toEqual({
      enabled: true,
      max_messages_per_tick: 50,
      skip_all_mail: true,
    });
  });

  /* REQUIREMENT end:comm/email-client-mcp/config -- watcher recent-first sync has bounded safe defaults */
  it("defaults watcher recent-first sync settings", () => {
    const parsed = configSchema.parse({ accounts: [account] });

    expect(parsed.watcher.recent_first).toEqual({
      enabled: true,
      initial_recent_window: 1000,
      backfill_window_per_tick: 500,
    });
  });

  it("allows disabling eager body hydration", () => {
    const parsed = configSchema.parse({
      accounts: [account],
      watcher: {
        body_hydration: { enabled: false, max_messages_per_tick: 3, skip_all_mail: false },
      },
    });

    expect(parsed.watcher.body_hydration).toEqual({
      enabled: false,
      max_messages_per_tick: 3,
      skip_all_mail: false,
    });
  });
});
