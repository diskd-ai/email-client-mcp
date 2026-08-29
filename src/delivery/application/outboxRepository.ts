import type { Option, Result } from "../../domain/result.js";
import type { DeliveryProgress } from "../domain/deliveryProgress.js";
import type { JsonObject } from "../domain/json.js";

export type ExchangeState = "review" | "outbox" | "sent" | "failed" | "reconciliation_required";

export type OutboxLease =
  | { readonly kind: "Available" }
  | {
      readonly kind: "Leased";
      readonly owner: string;
      readonly expiresAt: string;
    };

export type OutboxItem = {
  readonly externalId: string;
  readonly account: string;
  readonly mailboxId: string;
  readonly state: ExchangeState;
  readonly payload: JsonObject;
  readonly result: Option<JsonObject>;
  readonly revision: string;
  readonly deliveryAttempts: number;
  readonly lease: OutboxLease;
  readonly failureReason: Option<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type OutboxRepositoryOperation =
  | "Get"
  | "ListPending"
  | "Claim"
  | "RenewLease"
  | "WriteProgress"
  | "WriteTerminal";

export type OutboxRepositoryError =
  | { readonly kind: "NotFound"; readonly operation: OutboxRepositoryOperation }
  | { readonly kind: "RevisionConflict"; readonly operation: OutboxRepositoryOperation }
  | { readonly kind: "LeaseConflict"; readonly operation: OutboxRepositoryOperation }
  | { readonly kind: "LeaseExpired"; readonly operation: OutboxRepositoryOperation }
  | {
      readonly kind: "InvalidResponse";
      readonly operation: OutboxRepositoryOperation;
      readonly message: string;
    }
  | {
      readonly kind: "SdkFailure";
      readonly operation: OutboxRepositoryOperation;
      readonly message: string;
    };

export type OutboxLeaseInput = {
  readonly externalId: string;
  readonly expectedRevision: string;
  readonly leaseOwner: string;
  readonly leaseSeconds: number;
};

export type OutboxTerminalOutcome =
  | { readonly kind: "Sent"; readonly providerResponse: JsonObject }
  | { readonly kind: "Failed"; readonly reason: string };

export type OutboxRepository = {
  readonly get: (externalId: string) => Promise<Result<OutboxRepositoryError, OutboxItem>>;
  readonly listPending: (input: {
    readonly limit: number;
    readonly cursor: Option<string>;
  }) => Promise<
    Result<
      OutboxRepositoryError,
      { readonly items: readonly OutboxItem[]; readonly nextCursor: Option<string> }
    >
  >;
  readonly claim: (input: OutboxLeaseInput) => Promise<Result<OutboxRepositoryError, OutboxItem>>;
  readonly renewLease: (
    input: OutboxLeaseInput,
  ) => Promise<Result<OutboxRepositoryError, OutboxItem>>;
  readonly writeProgress: (input: {
    readonly externalId: string;
    readonly expectedRevision: string;
    readonly progress: DeliveryProgress;
  }) => Promise<Result<OutboxRepositoryError, OutboxItem>>;
  readonly writeTerminal: (input: {
    readonly externalId: string;
    readonly expectedRevision: string;
    readonly leaseOwner: string;
    readonly outcome: OutboxTerminalOutcome;
  }) => Promise<Result<OutboxRepositoryError, OutboxItem>>;
};
