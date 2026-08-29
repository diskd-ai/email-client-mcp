import { describe, expect, it, vi } from "vitest";
import {
  type ExchangeDeliveryProtocol,
  registerExchangeDeliveryHandler,
} from "../../src/delivery/infrastructure/deliveryProtocol.js";

describe("delivery/infrastructure/deliveryProtocol", () => {
  /* REQ-DELIVERY-052: The custom MCP request maps a locator to the delivery processor and returns its disposition. */
  /* REQ-DELIVERY-053: The custom handler accepts the JSON-RPC envelope supplied by the MCP SDK while keeping locator params strict. */
  it("handles exchange/deliver without registering a tool", async () => {
    let handler: ((request: unknown) => Promise<unknown>) | undefined;
    const setRequestHandler: ExchangeDeliveryProtocol["setRequestHandler"] = vi.fn(
      (schema, registeredHandler) => {
        handler = async (request) => registeredHandler(schema.parse(request));
      },
    );
    const processor = {
      process: vi.fn().mockResolvedValue({ kind: "Ack", reason: "already sent" }),
    };

    registerExchangeDeliveryHandler({ setRequestHandler }, processor);
    const result = await handler?.({
      jsonrpc: "2.0",
      id: 1,
      method: "exchange/deliver",
      params: {
        eventId: "event-1",
        account: "work",
        mailboxId: "exchange-work",
        externalId: "send-1",
        revision: "1",
      },
    });

    expect(result).toEqual({ kind: "Ack", reason: "already sent" });
    expect(processor.process).toHaveBeenCalledWith({
      kind: "EventLocator",
      eventId: "event-1",
      account: "work",
      mailboxId: "exchange-work",
      externalId: "send-1",
      revision: "1",
    });

    await expect(
      handler?.({
        jsonrpc: "2.0",
        id: 2,
        method: "exchange/deliver",
        params: {
          eventId: "event-2",
          account: "work",
          mailboxId: "exchange-work",
          externalId: "send-2",
          revision: "1",
          bodyText: "must be loaded from Drive",
        },
      }),
    ).rejects.toThrow();
    expect(processor.process).toHaveBeenCalledTimes(1);
  });
});
