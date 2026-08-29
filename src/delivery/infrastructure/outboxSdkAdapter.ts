import type {
  MessagesStoreClient,
  OutboxTerminalOutcome as SdkTerminalOutcome,
} from "@diskd-ai/sdk";
import { z } from "zod";
import { Err, None, Ok, type Option, type Result, Some } from "../../domain/result.js";
import { isValidMailboxId } from "../../store/conventions.js";
import type {
  ExchangeState,
  OutboxItem,
  OutboxLease,
  OutboxRepository,
  OutboxRepositoryError,
  OutboxRepositoryOperation,
  OutboxTerminalOutcome,
} from "../application/outboxRepository.js";
import { encodeDeliveryProgress } from "../domain/deliveryProgress.js";
import type { JsonObject, JsonValue } from "../domain/json.js";

type OutboxSdkBoundary = Pick<MessagesStoreClient, "exchange" | "outbox">;

const exchangeStateSchema: z.ZodType<ExchangeState> = z.enum([
  "review",
  "outbox",
  "sent",
  "failed",
  "reconciliation_required",
]);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(jsonValueSchema);

const sdkOutboxItemSchema = z
  .object({
    externalId: z.string().min(1),
    account: z.string().min(1),
    mailboxId: z.string().refine(isValidMailboxId, "invalid mailboxId"),
    state: exchangeStateSchema,
    payload: jsonObjectSchema,
    result: jsonObjectSchema.nullable(),
    revision: z.string().min(1),
    deliveryAttempts: z.number().int().min(0),
    leaseOwner: z.string().min(1).nullable(),
    leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
    failureReason: z.string().min(1).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const sdkOutboxPageSchema = z
  .object({
    items: z.array(z.unknown()),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

const toOption = <T>(value: T | null): Option<T> => (value === null ? None : Some(value));

const invalidResponse = (
  operation: OutboxRepositoryOperation,
  message: string,
): OutboxRepositoryError => ({ kind: "InvalidResponse", operation, message });

export const parseSdkOutboxItem = (
  operation: OutboxRepositoryOperation,
  rawItem: unknown,
): Result<OutboxRepositoryError, OutboxItem> => {
  const parsed = sdkOutboxItemSchema.safeParse(rawItem);
  if (!parsed.success) {
    return Err(
      invalidResponse(
        operation,
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      ),
    );
  }

  let lease: OutboxLease;
  if (parsed.data.leaseOwner === null && parsed.data.leaseExpiresAt === null) {
    lease = { kind: "Available" };
  } else if (parsed.data.leaseOwner !== null && parsed.data.leaseExpiresAt !== null) {
    lease = {
      kind: "Leased",
      owner: parsed.data.leaseOwner,
      expiresAt: parsed.data.leaseExpiresAt,
    };
  } else {
    return Err(invalidResponse(operation, "lease owner and expiry must be present together"));
  }

  if (
    (parsed.data.state === "sent" || parsed.data.state === "failed") &&
    lease.kind !== "Available"
  ) {
    return Err(invalidResponse(operation, "terminal item must not retain a lease"));
  }
  if (parsed.data.state === "failed" && parsed.data.failureReason === null) {
    return Err(invalidResponse(operation, "failed item must include a failure reason"));
  }

  return Ok({
    externalId: parsed.data.externalId,
    account: parsed.data.account,
    mailboxId: parsed.data.mailboxId,
    state: parsed.data.state,
    payload: parsed.data.payload,
    result: toOption(parsed.data.result),
    revision: parsed.data.revision,
    deliveryAttempts: parsed.data.deliveryAttempts,
    lease,
    failureReason: toOption(parsed.data.failureReason),
    createdAt: parsed.data.createdAt,
    updatedAt: parsed.data.updatedAt,
  });
};

const causeMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    return "unprintable SDK failure";
  }
};

const classifySdkFailure = (
  operation: OutboxRepositoryOperation,
  cause: unknown,
): OutboxRepositoryError => {
  const message = causeMessage(cause);
  if (/\bREVISION_CONFLICT\b/.test(message)) return { kind: "RevisionConflict", operation };
  if (/\bLEASE_CONFLICT\b/.test(message)) return { kind: "LeaseConflict", operation };
  if (/\bLEASE_EXPIRED\b/.test(message)) return { kind: "LeaseExpired", operation };
  if (/\bNOT_FOUND\b/.test(message)) return { kind: "NotFound", operation };
  if (/Invalid messages_store response/.test(message)) {
    return invalidResponse(operation, message);
  }
  return { kind: "SdkFailure", operation, message };
};

const runItemOperation = async (
  operation: OutboxRepositoryOperation,
  call: () => Promise<unknown>,
): Promise<Result<OutboxRepositoryError, OutboxItem>> => {
  try {
    return parseSdkOutboxItem(operation, await call());
  } catch (cause) {
    return Err(classifySdkFailure(operation, cause));
  }
};

const toSdkTerminalOutcome = (outcome: OutboxTerminalOutcome): SdkTerminalOutcome =>
  outcome.kind === "Sent"
    ? { state: "sent", providerResponse: outcome.providerResponse }
    : { state: "failed", reason: outcome.reason };

export const buildOutboxRepository = (sdk: OutboxSdkBoundary): OutboxRepository => ({
  get: (externalId) => runItemOperation("Get", () => sdk.outbox.get({ externalId })),
  listPending: async (input) => {
    try {
      const rawPage = await sdk.outbox.listPending({
        limit: input.limit,
        ...(input.cursor.tag === "Some" ? { cursor: input.cursor.value } : {}),
      });
      const parsedPage = sdkOutboxPageSchema.safeParse(rawPage);
      if (!parsedPage.success) {
        return Err(
          invalidResponse(
            "ListPending",
            parsedPage.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
          ),
        );
      }

      const parsedItems = parsedPage.data.items.map((item) =>
        parseSdkOutboxItem("ListPending", item),
      );
      const failedItem = parsedItems.find((item) => item.tag === "Err");
      if (failedItem !== undefined && failedItem.tag === "Err") return failedItem;

      return Ok({
        items: parsedItems.flatMap((item) => (item.tag === "Ok" ? [item.value] : [])),
        nextCursor: toOption(parsedPage.data.nextCursor),
      });
    } catch (cause) {
      return Err(classifySdkFailure("ListPending", cause));
    }
  },
  claim: (input) => runItemOperation("Claim", () => sdk.outbox.claim(input)),
  renewLease: (input) => runItemOperation("RenewLease", () => sdk.outbox.renewLease(input)),
  writeProgress: (input) =>
    runItemOperation("WriteProgress", () =>
      sdk.exchange.update({
        externalId: input.externalId,
        expectedRevision: input.expectedRevision,
        patch: { result: encodeDeliveryProgress(input.progress) },
      }),
    ),
  writeTerminal: (input) =>
    runItemOperation("WriteTerminal", () =>
      sdk.outbox.writeTerminal({
        externalId: input.externalId,
        expectedRevision: input.expectedRevision,
        leaseOwner: input.leaseOwner,
        outcome: toSdkTerminalOutcome(input.outcome),
      }),
    ),
});
