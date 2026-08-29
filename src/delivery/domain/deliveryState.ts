/**
 * Canonical delivery lifecycle variants understood by the delivery feature.
 * Drive owns persistence and revision rules; this module only models the
 * locally observable states without importing an SDK DTO.
 */

export type DeliveryState =
  | { readonly kind: "Pending" }
  | { readonly kind: "Claimed" }
  | { readonly kind: "Sending" }
  | { readonly kind: "RetryScheduled" }
  | { readonly kind: "Sent" }
  | { readonly kind: "FailedPermanent" }
  | { readonly kind: "FailedUnknown" };

export const isTerminalDeliveryState = (state: DeliveryState): boolean =>
  state.kind === "Sent" || state.kind === "FailedPermanent" || state.kind === "FailedUnknown";
