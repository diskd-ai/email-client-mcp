import { describe, expect, it } from "vitest";
import {
  type DeliveryState,
  isTerminalDeliveryState,
} from "../../src/delivery/domain/deliveryState.js";

describe("delivery/domain/deliveryState", () => {
  /* REQ-DELIVERY-001: Only Sent and explicit failure outcomes are terminal. */
  it("classifies terminal lifecycle variants", () => {
    const nonTerminal: readonly DeliveryState[] = [
      { kind: "Pending" },
      { kind: "Claimed" },
      { kind: "Sending" },
      { kind: "RetryScheduled" },
    ];
    const terminal: readonly DeliveryState[] = [
      { kind: "Sent" },
      { kind: "FailedPermanent" },
      { kind: "FailedUnknown" },
    ];

    expect(nonTerminal.map(isTerminalDeliveryState)).toEqual([false, false, false, false]);
    expect(terminal.map(isTerminalDeliveryState)).toEqual([true, true, true]);
  });
});
