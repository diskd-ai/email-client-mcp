import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";

const account = {
  name: "work",
  email: "work@example.com",
  password: "secret",
  imap: { host: "imap.example.com", port: 993 },
};

describe("config/schema", () => {
  /* REQ-CONFIG-001: Default watcher interval avoids per-minute idle IMAP scans. */
  it("defaults watcher interval to 5 minutes", () => {
    const parsed = configSchema.parse({ accounts: [account] });

    expect(parsed.watcher.interval_ms).toBe(300_000);
  });

  /* REQ-CONFIG-002: Watcher body hydration has safe eager defaults. */
  it("defaults watcher body hydration settings", () => {
    const parsed = configSchema.parse({ accounts: [account] });

    expect(parsed.watcher.body_hydration).toEqual({
      enabled: true,
      max_messages_per_tick: 50,
      skip_all_mail: true,
    });
  });

  /* REQ-CONFIG-003: Watcher recent-first sync has bounded safe defaults. */
  it("defaults watcher recent-first sync settings", () => {
    const parsed = configSchema.parse({ accounts: [account] });

    expect(parsed.watcher.recent_first).toEqual({
      enabled: true,
      initial_recent_window: 1000,
      backfill_window_per_tick: 500,
    });
  });

  /* REQ-CONFIG-004: Body hydration can be explicitly disabled. */
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

  /* REQ-DELIVERY-010: SMTP settings are optional and TLS defaults to enabled. */
  it("parses per-account SMTP settings", () => {
    const parsed = configSchema.parse({
      accounts: [
        {
          ...account,
          smtp: { host: "smtp.example.com", port: 465 },
        },
      ],
    });

    expect(parsed.accounts[0]?.smtp).toEqual({
      host: "smtp.example.com",
      port: 465,
      tls: true,
      starttls: false,
      verify_ssl: true,
    });
  });

  /* REQ-DELIVERY-011: Account selectors and derived mailbox IDs are unique. */
  it.each([
    {
      name: "account name",
      duplicate: { ...account, email: "other@example.com" },
      message: "duplicate account name",
    },
    {
      name: "derived mailbox ID",
      duplicate: { ...account, name: "work!", email: "other@example.com" },
      message: "duplicate mailbox id",
    },
  ])("rejects a duplicate $name", ({ duplicate, message }) => {
    const parsed = configSchema.safeParse({ accounts: [account, duplicate] });

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain(message);
  });

  /* REQ-DELIVERY-057: Distinct vault account selectors may address the same provider mailbox. */
  it("allows distinct account selectors with the same sender email", () => {
    const parsed = configSchema.safeParse({
      accounts: [account, { ...account, name: "other", email: " WORK@example.com " }],
    });

    expect(parsed.success).toBe(true);
  });

  /* REQ-DELIVERY-012: SMTP ports outside the TCP range fail at the config boundary. */
  it("rejects invalid SMTP settings", () => {
    const parsed = configSchema.safeParse({
      accounts: [{ ...account, smtp: { host: "smtp.example.com", port: 0 } }],
    });

    expect(parsed.success).toBe(false);
  });

  /* REQ-DELIVERY-016: Delivery configuration carries only the account rate limit; provider pods do not receive NATS access. */
  it("parses enabled delivery settings", () => {
    const parsed = configSchema.parse({
      accounts: [
        {
          ...account,
          smtp: {
            host: "smtp.example.com",
            port: 587,
            tls: false,
            starttls: true,
            verify_ssl: true,
          },
        },
      ],
      deliver: {
        enabled: true,
        rate_limit_per_account_per_minute: 12,
      },
    });

    expect(parsed.deliver).toEqual({
      enabled: true,
      rate_limit_per_account_per_minute: 12,
    });
    expect(parsed.accounts[0]?.smtp).toEqual({
      host: "smtp.example.com",
      port: 587,
      tls: false,
      starttls: true,
      verify_ssl: true,
    });
  });

  /* REQ-DELIVERY-017: Inbound-only configurations remain explicit and do not start delivery. */
  it("defaults delivery to disabled", () => {
    const parsed = configSchema.parse({ accounts: [account] });

    expect(parsed.deliver).toEqual({ enabled: false });
  });

  /* REQ-DELIVERY-018: Every account must expose SMTP when delivery is enabled. */
  it("rejects enabled delivery when an account lacks SMTP", () => {
    const parsed = configSchema.safeParse({
      accounts: [account],
      deliver: {
        enabled: true,
        rate_limit_per_account_per_minute: 10,
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain("SMTP settings are required");
  });
});
