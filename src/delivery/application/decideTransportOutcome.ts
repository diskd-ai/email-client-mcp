import type { TransportOutcome } from "../domain/transportOutcome.js";

export type DeliveryOutcomeDecision =
  | { readonly kind: "RecordSent" }
  | { readonly kind: "ScheduleRetry"; readonly reason: string }
  | { readonly kind: "RecordFailedPermanent"; readonly reason: string }
  | { readonly kind: "RecordFailedUnknown"; readonly reason: string };

/** Convert a normalized transport outcome into one canonical lifecycle effect. */
export const decideTransportOutcome = (outcome: TransportOutcome): DeliveryOutcomeDecision => {
  switch (outcome.kind) {
    case "Accepted":
      return { kind: "RecordSent" };
    case "UnknownOutcome":
      return { kind: "RecordFailedUnknown", reason: outcome.failure.reason };
    case "RejectedBeforeAcceptance":
      return outcome.rejection.kind === "Transient"
        ? { kind: "ScheduleRetry", reason: outcome.rejection.failure.reason }
        : { kind: "RecordFailedPermanent", reason: outcome.rejection.failure.reason };
  }
};
