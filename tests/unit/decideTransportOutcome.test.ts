import { describe, expect, it } from "vitest";
import { decideTransportOutcome } from "../../src/delivery/application/decideTransportOutcome.js";

describe("delivery/application/decideTransportOutcome", () => {
  /* REQ-DELIVERY-002: Accepted SMTP delivery records Sent without retry. */
  it("records accepted delivery as sent", () => {
    expect(
      decideTransportOutcome({
        kind: "Accepted",
        receipt: {
          messageId: "<message@example.com>",
          accepted: ["lead@example.com"],
          rejected: [],
          response: "250 queued",
        },
      }),
    ).toEqual({ kind: "RecordSent" });
  });

  /* REQ-DELIVERY-003: Only transient failures proven before acceptance are retried. */
  it("schedules retry for transient pre-acceptance rejection", () => {
    expect(
      decideTransportOutcome({
        kind: "RejectedBeforeAcceptance",
        rejection: { kind: "Transient", failure: { reason: "connection refused" } },
      }),
    ).toEqual({ kind: "ScheduleRetry", reason: "connection refused" });
  });

  /* REQ-DELIVERY-004: Permanent pre-acceptance rejection becomes terminal failure. */
  it("records permanent pre-acceptance rejection", () => {
    expect(
      decideTransportOutcome({
        kind: "RejectedBeforeAcceptance",
        rejection: { kind: "Permanent", failure: { reason: "sender rejected" } },
      }),
    ).toEqual({ kind: "RecordFailedPermanent", reason: "sender rejected" });
  });

  /* REQ-DELIVERY-005: Ambiguous SMTP outcomes never enter automatic retry. */
  it("records unknown outcome as terminal unknown", () => {
    expect(
      decideTransportOutcome({
        kind: "UnknownOutcome",
        failure: { reason: "response lost after submission" },
      }),
    ).toEqual({ kind: "RecordFailedUnknown", reason: "response lost after submission" });
  });
});
