import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildPlatformEventNotifier,
  computeExchangeInboxCreatedEventId,
} from "../../src/events/platformEventNotifier.js";

const locator = {
  accountId: "work",
  mailboxId: "exchange-work",
  folderId: "INBOX",
  externalId: "42:101",
} as const;

describe("events/platformEventNotifier", () => {
  /* REQ-EMAIL-EVENT-001: Inbox locator events have deterministic identities for downstream deduplication. */
  it("derives a stable event id from workspace and locator identity", () => {
    expect(computeExchangeInboxCreatedEventId("workspace-1", locator)).toBe(
      computeExchangeInboxCreatedEventId("workspace-1", locator),
    );
    expect(computeExchangeInboxCreatedEventId("workspace-1", locator)).not.toBe(
      computeExchangeInboxCreatedEventId("workspace-2", locator),
    );
  });

  /* REQ-EMAIL-EVENT-002: Email persistence signals leave the service through a typed MCP notification with locator-only data. */
  it("emits the canonical platform event notification", async () => {
    const notification = vi.fn(async () => undefined);
    const server = { server: { notification } } as unknown as McpServer;
    const notifier = buildPlatformEventNotifier(server, "workspace-1");

    await notifier.notifyExchangeInboxCreated(locator);

    expect(notification).toHaveBeenCalledWith({
      method: "notifications/platform/event",
      params: {
        id: computeExchangeInboxCreatedEventId("workspace-1", locator),
        type: "exchange.inbox.created",
        data: locator,
      },
    });
  });
});
