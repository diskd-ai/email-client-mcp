import { describe, expect, it } from "vitest";
import { deliveryConsumerName } from "../../src/delivery/infrastructure/deliveryRuntime.js";

describe("delivery/infrastructure/deliveryRuntime", () => {
  /* REQ-DELIVERY-043: Each workspace owns one stable durable consumer without versioned identifiers. */
  it("derives a stable NATS-safe durable name", () => {
    expect(deliveryConsumerName("workspace-1")).toBe(deliveryConsumerName("workspace-1"));
    expect(deliveryConsumerName("workspace-1")).toMatch(/^email-client-mcp-[a-f0-9]{24}$/);
    expect(deliveryConsumerName("workspace-1")).not.toBe(deliveryConsumerName("workspace-2"));
  });
});
