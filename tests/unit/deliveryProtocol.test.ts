import { describe, expect, it, vi } from "vitest";
import { registerExchangeDeliveryHandler } from "../../src/delivery/infrastructure/deliveryProtocol.js";

describe("delivery/infrastructure/deliveryProtocol", () => {
  /* REQ-DELIVERY-052: The custom MCP request maps a locator to the delivery processor and returns its disposition. */
  it("handles exchange/deliver without registering a tool", async () => {
    let handler: ((request: unknown) => Promise<unknown>) | undefined;
    const setRequestHandler = vi.fn((_schema, registeredHandler) => {
      handler = registeredHandler;
    });
    const processor = {
      process: vi.fn().mockResolvedValue({ kind: "Ack", reason: "already sent" }),
    };

    registerExchangeDeliveryHandler({ setRequestHandler }, processor);
    const result = await handler?.({
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
  });
});
