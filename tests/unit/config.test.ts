import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";

const account = {
  name: "work",
  email: "work@example.com",
  password: "secret",
  imap: { host: "imap.example.com", port: 993 },
};

describe("config/schema", () => {
  /* REQUIREMENT end:comm/email-client-mcp/config -- watcher body hydration has safe eager defaults */
  it("defaults watcher body hydration settings", () => {
    const parsed = configSchema.parse({ accounts: [account] });

    expect(parsed.watcher.body_hydration).toEqual({
      enabled: true,
      max_messages_per_tick: 50,
      skip_all_mail: true,
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
