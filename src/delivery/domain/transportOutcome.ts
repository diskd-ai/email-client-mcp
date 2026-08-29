/** Normalized SMTP failure details. Provider-specific objects stay in adapters. */
export type TransportFailure = {
  readonly reason: string;
};

export type TransportReceipt = {
  readonly messageId: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly response: string;
};

export type PreAcceptanceFailure =
  | {
      readonly kind: "Transient";
      readonly failure: TransportFailure;
    }
  | {
      readonly kind: "Permanent";
      readonly failure: TransportFailure;
    };

/**
 * SMTP outcome at the only boundary that controls automatic retry safety.
 * Unknown outcomes are intentionally distinct from definitive rejection.
 */
export type TransportOutcome =
  | { readonly kind: "Accepted"; readonly receipt: TransportReceipt }
  | {
      readonly kind: "RejectedBeforeAcceptance";
      readonly rejection: PreAcceptanceFailure;
    }
  | {
      readonly kind: "UnknownOutcome";
      readonly failure: TransportFailure;
    };
