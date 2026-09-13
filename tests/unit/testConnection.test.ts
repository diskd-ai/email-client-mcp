import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../../src/config/schema.js";
import type { ImapPool } from "../../src/imap/pool.js";
import { registerTools, type ToolDeps } from "../../src/tools/registry.js";
import { testConnection, testConnectionInput } from "../../src/tools/testConnection.js";

const { createTransport, verify, close } = vi.hoisted(() => ({
  createTransport: vi.fn(),
  verify: vi.fn(),
  close: vi.fn(),
}));
vi.mock("nodemailer", () => ({ createTransport }));

const account: Account = {
  name: "mail__fixture",
  email: "fixture@example.test",
  username: "fixture-login",
  password: "fixture-password",
  imap: { host: "imap.example.test", port: 3143, tls: false, verify_ssl: true },
  smtp: { host: "smtp.example.test", port: 3025, tls: false, starttls: false, verify_ssl: true },
};

/** Mock only the IMAP transport edge; all tool selection and result shaping stay real. */
function makePool() {
  const noop = vi.fn().mockResolvedValue(undefined);
  const forAccount = vi
    .fn()
    .mockResolvedValue({ tag: "Ok", value: { noop } as unknown as ImapFlow });
  const pool: ImapPool = { accountIds: [account.name], forAccount, closeAll: vi.fn() };
  return { pool, noop, forAccount };
}

describe("Vault connection probe contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verify.mockResolvedValue(true);
    createTransport.mockReturnValue({ verify, close });
  });

  it("accepts only the existing account_name selector", () => {
    /* REQ-2981-PROBE-001: The adapter accepts Vault's exact selector without arbitrary credentials or spelling aliases. */
    expect(testConnectionInput.parse({ account_name: account.name })).toEqual({
      account_name: account.name,
    });
    for (const input of [
      {},
      { account: account.name },
      { account_name: "" },
      { account_name: account.name, password: "override" },
    ]) {
      expect(testConnectionInput.safeParse(input).success).toBe(false);
    }
  });

  it("registers test_connection and returns the result shape consumed by Vault", async () => {
    /* REQ-2981-PROBE-002: Catalog registration and the real handler return both protocol statuses through MCP text JSON. */
    const { pool } = makePool();
    const server = new McpServer({ name: "connection-probe-test", version: "1.0.0" });
    const registered = vi.spyOn(server, "registerTool");
    // Other tools are registered but not invoked; their adapters are outside this probe.
    const deps = { accounts: [account], imapPool: pool } as unknown as ToolDeps;
    registerTools(server, deps);
    const call = registered.mock.calls.find(([name]) => name === "test_connection");
    expect(call).toBeDefined();
    if (!call) throw new Error("Connection tool missing");
    const result = await call[2]({ account_name: account.name }, {} as never);
    expect(result.isError).not.toBe(true);
    const output = process.env.EMAIL_PROBE_CONTRACT_OUTPUT;
    if (output) writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    const text = result.content.find((item) => item.type === "text");
    if (!text || text.type !== "text") throw new Error("Missing text result");
    expect(JSON.parse(text.text)).toEqual({
      imap: { status: "ok", latencyMs: expect.any(Number) },
      smtp: { status: "ok", latencyMs: expect.any(Number) },
    });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.test",
        port: 3025,
        auth: { type: "login", user: "fixture-login", pass: "fixture-password" },
      }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown account before either protocol is contacted", async () => {
    /* REQ-2981-PROBE-003: A caller cannot probe a configuration absent from the mounted account owner. */
    const { pool, forAccount } = makePool();
    const result = await testConnection(pool, [account], { account_name: "mail__missing" });
    expect(result.tag).toBe("Err");
    expect(forAccount).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("reports an IMAP authentication failure while still testing SMTP", async () => {
    /* REQ-2981-PROBE-004: One failed protocol cannot hide the independent other protocol outcome. */
    const { pool, forAccount } = makePool();
    forAccount.mockResolvedValue({
      tag: "Err",
      error: { kind: "ImapError", accountId: account.name, message: "Authentication failed" },
    });
    const result = await testConnection(pool, [account], { account_name: account.name });
    expect(result).toMatchObject({
      tag: "Ok",
      value: {
        imap: { status: "error", error: expect.stringContaining("Authentication failed") },
        smtp: { status: "ok" },
      },
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("reports a live IMAP command failure", async () => {
    /* REQ-2981-PROBE-005: A cached IMAP connection is verified by an actual command. */
    const { pool, noop } = makePool();
    noop.mockRejectedValue(new Error("IMAP disconnected"));
    await expect(
      testConnection(pool, [account], { account_name: account.name }),
    ).resolves.toMatchObject({
      tag: "Ok",
      value: { imap: { status: "error", error: "IMAP disconnected" } },
    });
  });

  it("reports SMTP failure and closes its transport without sending mail", async () => {
    /* REQ-2981-PROBE-006: SMTP verification failure remains a visible typed outcome and releases its connection. */
    const { pool } = makePool();
    verify.mockRejectedValue(new Error("SMTP authentication failed"));
    await expect(
      testConnection(pool, [account], { account_name: account.name }),
    ).resolves.toMatchObject({
      tag: "Ok",
      value: {
        imap: { status: "ok" },
        smtp: { status: "error", error: "SMTP authentication failed" },
      },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports missing SMTP settings without inventing a server", async () => {
    /* REQ-2981-PROBE-007: Missing owner configuration is an explicit protocol error. */
    const { pool } = makePool();
    await expect(
      testConnection(pool, [{ ...account, smtp: undefined }], { account_name: account.name }),
    ).resolves.toMatchObject({
      tag: "Ok",
      value: { smtp: { status: "error", error: expect.stringContaining("SMTP") } },
    });
    expect(createTransport).not.toHaveBeenCalled();
  });
});
