import { describe, expect, it } from "vitest";
import {
  decodeDeliveryProgress,
  encodeDeliveryProgress,
} from "../../src/delivery/domain/deliveryProgress.js";

describe("delivery/domain/deliveryProgress", () => {
  /* REQ-DELIVERY-025: A durable pre-send marker prevents an uncertain process restart from resending. */
  it("round-trips the delivery-started marker", () => {
    const progress = {
      kind: "DeliveryStarted" as const,
      messageId: "message-1",
      recordedAt: "2026-08-29T12:00:00.000Z",
    };

    expect(decodeDeliveryProgress(encodeDeliveryProgress(progress))).toEqual({
      tag: "Ok",
      value: progress,
    });
  });

  /* REQ-DELIVERY-026: Only a proven pre-acceptance rejection creates a retry-safe marker. */
  it("round-trips the retry-safe marker", () => {
    const progress = {
      kind: "RetrySafe" as const,
      reason: "connection refused before SMTP submission",
      recordedAt: "2026-08-29T12:01:00.000Z",
    };

    expect(decodeDeliveryProgress(encodeDeliveryProgress(progress))).toEqual({
      tag: "Ok",
      value: progress,
    });
  });

  /* REQ-DELIVERY-027: Unknown persisted progress never authorizes an automatic resend. */
  it("rejects unrecognized progress", () => {
    expect(decodeDeliveryProgress({ deliveryProgress: "mystery" })).toEqual({
      tag: "Err",
      error: {
        kind: "InvalidDeliveryProgress",
        reason: "Outbox result is not a recognized delivery progress marker",
      },
    });
  });
});
