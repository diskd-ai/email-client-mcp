import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const PLATFORM_EVENT_NOTIFICATION_METHOD = "notifications/platform/event" as const;
export const EXCHANGE_INBOX_CREATED_EVENT = "exchange.inbox.created" as const;

export type ExchangeInboxCreatedLocator = {
  readonly accountId: string;
  readonly mailboxId: string;
  readonly folderId: string;
  readonly externalId: string;
};

export type PlatformEventNotification = {
  readonly method: typeof PLATFORM_EVENT_NOTIFICATION_METHOD;
  readonly params: {
    readonly id: string;
    readonly type: typeof EXCHANGE_INBOX_CREATED_EVENT;
    readonly data: ExchangeInboxCreatedLocator;
  };
};

type PlatformEventProtocol = {
  readonly notification: (notification: PlatformEventNotification) => Promise<void>;
};

export type PlatformEventNotifier = {
  readonly notifyExchangeInboxCreated: (event: ExchangeInboxCreatedLocator) => Promise<void>;
};

export const computeExchangeInboxCreatedEventId = (
  workspaceId: string,
  event: ExchangeInboxCreatedLocator,
): string =>
  createHash("sha256")
    .update(
      [
        EXCHANGE_INBOX_CREATED_EVENT,
        workspaceId,
        event.accountId,
        event.mailboxId,
        event.folderId,
        event.externalId,
      ].join("|"),
    )
    .digest("hex");

/** Isolate the MCP SDK's non-generic high-level server at the custom notification boundary. */
const platformEventProtocol = (server: McpServer): PlatformEventProtocol =>
  server.server as unknown as PlatformEventProtocol;

export const buildPlatformEventNotifier = (
  server: McpServer,
  workspaceId: string,
): PlatformEventNotifier => {
  const protocol = platformEventProtocol(server);
  return {
    notifyExchangeInboxCreated: async (event) =>
      protocol.notification({
        method: PLATFORM_EVENT_NOTIFICATION_METHOD,
        params: {
          id: computeExchangeInboxCreatedEventId(workspaceId, event),
          type: EXCHANGE_INBOX_CREATED_EVENT,
          data: event,
        },
      }),
  };
};
