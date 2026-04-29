import { EventEmitter } from "node:events";
import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import type { Account } from "../../src/config/schema.js";
import { buildImapPool, type ImapPoolEvent } from "../../src/imap/pool.js";

const acct: Account = {
  name: "work",
  email: "work@example.com",
  full_name: "Work",
  password: "x",
  imap: { host: "imap.example.com", port: 993, tls: true, verify_ssl: false },
};

class FakeImapClient extends EventEmitter {
  usable = false;
  connectCalls = 0;
  closeCalls = 0;
  logoutCalls = 0;

  constructor(private readonly connectFailure: Error | null = null) {
    super();
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectFailure !== null) throw this.connectFailure;
    this.usable = true;
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1;
    this.usable = false;
  }

  close(): void {
    this.closeCalls += 1;
    this.usable = false;
  }
}

const asImapFlow = (client: FakeImapClient): ImapFlow => client as unknown as ImapFlow;

describe("imap pool", () => {
  /* REQUIREMENT end:comm/email-client-mcp/imap/pool -- IMAP client error events are handled and evict the broken client */
  it("handles emitted client errors without throwing", async () => {
    const clients: FakeImapClient[] = [];
    const events: ImapPoolEvent[] = [];
    const waits: number[] = [];

    const pool = buildImapPool([acct], {
      reconnectDelayMs: 30_000,
      nowMs: () => 0,
      sleep: async (delayMs) => {
        waits.push(delayMs);
      },
      onEvent: (event) => events.push(event),
      createClient: () => {
        const client = new FakeImapClient();
        clients.push(client);
        return asImapFlow(client);
      },
    });

    const first = await pool.forAccount("work");
    expect(first.tag).toBe("Ok");
    const firstClient = clients[0];
    expect(firstClient).toBeDefined();
    expect(() => firstClient?.emit("error", new Error("Socket timeout"))).not.toThrow();
    expect(firstClient?.closeCalls).toBe(1);

    const second = await pool.forAccount("work");
    expect(second.tag).toBe("Ok");
    expect(clients).toHaveLength(2);
    expect(waits).toEqual([30_000]);
    expect(events).toContainEqual({
      kind: "clientError",
      accountId: "work",
      message: "Socket timeout",
      reconnectDelayMs: 30_000,
    });
  });

  /* REQUIREMENT end:comm/email-client-mcp/imap/pool -- failed connect attempts throttle the next reconnect by 30 seconds */
  it("waits before reconnecting after a connect failure", async () => {
    const clients = [new FakeImapClient(new Error("Command failed")), new FakeImapClient()];
    const waits: number[] = [];
    let nextClientIndex = 0;

    const pool = buildImapPool([acct], {
      reconnectDelayMs: 30_000,
      nowMs: () => 0,
      sleep: async (delayMs) => {
        waits.push(delayMs);
      },
      createClient: () => {
        const client = clients[nextClientIndex];
        nextClientIndex += 1;
        if (client === undefined) throw new Error("missing fake client");
        return asImapFlow(client);
      },
    });

    const first = await pool.forAccount("work");
    expect(first.tag).toBe("Err");
    expect(waits).toEqual([]);

    const second = await pool.forAccount("work");
    expect(second.tag).toBe("Ok");
    expect(waits).toEqual([30_000]);
    expect(clients[0]?.closeCalls).toBe(1);
    expect(clients[1]?.connectCalls).toBe(1);
  });
});
