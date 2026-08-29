import type { ExchangeItem, MessagesStoreClient } from "@diskd-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  buildOutboxRepository,
  parseSdkOutboxItem,
} from "../../src/delivery/infrastructure/outboxSdkAdapter.js";
import { None, Some } from "../../src/domain/result.js";

const availableItem: ExchangeItem = {
  externalId: "lead-1",
  account: "work",
  mailboxId: "exchange-work",
  state: "outbox",
  payload: { from: "work@example.com", subject: "Hello" },
  result: null,
  revision: "2",
  deliveryAttempts: 0,
  leaseOwner: null,
  leaseExpiresAt: null,
  failureReason: null,
  createdAt: "2026-08-29T08:00:00.000Z",
  updatedAt: "2026-08-29T08:00:00.000Z",
};

const leasedItem: ExchangeItem = {
  ...availableItem,
  revision: "3",
  deliveryAttempts: 1,
  leaseOwner: "deliver-1",
  leaseExpiresAt: "2026-08-29T08:01:00.000Z",
};

const buildSdk = (options?: {
  readonly claimErrorCode?: string;
  readonly pendingItems?: readonly ExchangeItem[];
  readonly nextCursor?: string | null;
}): Pick<MessagesStoreClient, "exchange" | "outbox"> => {
  const outbox = {
    create: vi.fn(async () => availableItem),
    get: vi.fn(async () => availableItem),
    listPending: vi.fn(async () => ({
      items: options?.pendingItems ?? [availableItem],
      nextCursor: options?.nextCursor === undefined ? "next-1" : options.nextCursor,
    })),
    claim: vi.fn(async () => {
      if (options?.claimErrorCode !== undefined) {
        throw new Error(`JSON-RPC error: {"message":"${options.claimErrorCode}"}`);
      }
      return leasedItem;
    }),
    renewLease: vi.fn(async () => ({ ...leasedItem, revision: "4" })),
    writeTerminal: vi.fn(async () => ({
      ...availableItem,
      state: "sent",
      revision: "4",
      deliveryAttempts: 1,
      result: { response: "250 queued" },
    })),
  } as unknown as MessagesStoreClient["outbox"];
  const exchange = {
    update: vi.fn(async () => ({
      ...leasedItem,
      revision: "4",
      result: {
        deliveryProgress: "started",
        messageId: "message-1",
        recordedAt: "2026-08-29T08:00:00.000Z",
      },
    })),
  } as unknown as MessagesStoreClient["exchange"];
  return { exchange, outbox };
};

describe("delivery/infrastructure/outboxSdkAdapter", () => {
  /* REQ-DELIVERY-017: SDK items become local typed items without nullable business absence. */
  it("maps canonical SDK items into the application port", async () => {
    const repository = buildOutboxRepository(buildSdk());

    expect(await repository.get("lead-1")).toEqual({
      tag: "Ok",
      value: {
        externalId: "lead-1",
        account: "work",
        mailboxId: "exchange-work",
        state: "outbox",
        payload: { from: "work@example.com", subject: "Hello" },
        result: None,
        revision: "2",
        deliveryAttempts: 0,
        lease: { kind: "Available" },
        failureReason: None,
        createdAt: "2026-08-29T08:00:00.000Z",
        updatedAt: "2026-08-29T08:00:00.000Z",
      },
    });
  });

  /* REQ-DELIVERY-049: Drive offset timestamps are normalized at the SDK adapter boundary. */
  it("accepts PostgreSQL offset timestamps returned by Drive", () => {
    const result = parseSdkOutboxItem("Get", {
      ...availableItem,
      createdAt: "2026-08-29 15:47:09.458317+00:00",
      updatedAt: "2026-08-29 15:47:50.107800+00:00",
    });

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.createdAt).toBe("2026-08-29T15:47:09.458317+00:00");
      expect(result.value.updatedAt).toBe("2026-08-29T15:47:50.107800+00:00");
    }
  });

  /* REQ-DELIVERY-018: Pending pagination and cursor absence use explicit local variants. */
  it("maps pending pages and forwards an explicit cursor", async () => {
    const sdk = buildSdk();
    const repository = buildOutboxRepository(sdk);

    const result = await repository.listPending({ limit: 25, cursor: Some("cursor-1") });

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.nextCursor).toEqual(Some("next-1"));
    }
    expect(sdk.outbox.listPending).toHaveBeenCalledWith({ limit: 25, cursor: "cursor-1" });
  });

  /* REQ-DELIVERY-019: Lease operations preserve opaque revision and owner fields exactly. */
  it("forwards claim and renewal through the canonical SDK", async () => {
    const sdk = buildSdk();
    const repository = buildOutboxRepository(sdk);
    const input = {
      externalId: "lead-1",
      expectedRevision: "2",
      leaseOwner: "deliver-1",
      leaseSeconds: 60,
    };

    const claimed = await repository.claim(input);
    const renewed = await repository.renewLease({ ...input, expectedRevision: "3" });

    expect(claimed.tag).toBe("Ok");
    expect(renewed.tag).toBe("Ok");
    expect(sdk.outbox.claim).toHaveBeenCalledWith(input);
    expect(sdk.outbox.renewLease).toHaveBeenCalledWith({ ...input, expectedRevision: "3" });
  });

  /* REQ-DELIVERY-031: Delivery intent is durably marked through the canonical SDK before SMTP starts. */
  it("writes delivery progress through the generic Exchange update boundary", async () => {
    const sdk = buildSdk();
    const repository = buildOutboxRepository(sdk);

    await repository.writeProgress({
      externalId: "lead-1",
      expectedRevision: "3",
      progress: {
        kind: "DeliveryStarted",
        messageId: "message-1",
        recordedAt: "2026-08-29T08:00:00.000Z",
      },
    });

    expect(sdk.exchange.update).toHaveBeenCalledWith({
      externalId: "lead-1",
      expectedRevision: "3",
      patch: {
        result: {
          deliveryProgress: "started",
          messageId: "message-1",
          recordedAt: "2026-08-29T08:00:00.000Z",
        },
      },
    });
  });

  /* REQ-DELIVERY-020: Terminal variants map to the SDK without provider DTO leakage. */
  it.each([
    {
      name: "sent",
      outcome: { kind: "Sent" as const, providerResponse: { response: "250 queued" } },
      sdkOutcome: { state: "sent", providerResponse: { response: "250 queued" } },
    },
    {
      name: "failed",
      outcome: { kind: "Failed" as const, reason: "sender rejected" },
      sdkOutcome: { state: "failed", reason: "sender rejected" },
    },
  ])("writes $name through the lease guard", async ({ outcome, sdkOutcome }) => {
    const sdk = buildSdk();
    const repository = buildOutboxRepository(sdk);

    await repository.writeTerminal({
      externalId: "lead-1",
      expectedRevision: "3",
      leaseOwner: "deliver-1",
      outcome,
    });

    expect(sdk.outbox.writeTerminal).toHaveBeenCalledWith({
      externalId: "lead-1",
      expectedRevision: "3",
      leaseOwner: "deliver-1",
      outcome: sdkOutcome,
    });
  });

  /* REQ-DELIVERY-021: SDK lifecycle conflicts remain explicit retry decisions. */
  it.each([
    ["REVISION_CONFLICT", "RevisionConflict"],
    ["LEASE_CONFLICT", "LeaseConflict"],
    ["LEASE_EXPIRED", "LeaseExpired"],
    ["NOT_FOUND", "NotFound"],
  ])("maps %s to %s", async (sdkCode, errorKind) => {
    const sdk = buildSdk({ claimErrorCode: sdkCode });
    const repository = buildOutboxRepository(sdk);

    const result = await repository.claim({
      externalId: "lead-1",
      expectedRevision: "2",
      leaseOwner: "deliver-1",
      leaseSeconds: 60,
    });

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.kind).toBe(errorKind);
  });

  /* REQ-DELIVERY-022: Malformed SDK output is surfaced before application orchestration. */
  it("rejects inconsistent lease data", () => {
    const result = parseSdkOutboxItem("Get", {
      ...availableItem,
      leaseOwner: "deliver-1",
      leaseExpiresAt: null,
    });

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.kind).toBe("InvalidResponse");
  });

  /* REQ-DELIVERY-023: An absent pending cursor is represented explicitly. */
  it("omits an absent SDK cursor", async () => {
    const sdk = buildSdk({ pendingItems: [], nextCursor: null });
    const repository = buildOutboxRepository(sdk);

    const result = await repository.listPending({ limit: 25, cursor: None });

    expect(result).toEqual({ tag: "Ok", value: { items: [], nextCursor: None } });
    expect(sdk.outbox.listPending).toHaveBeenCalledWith({ limit: 25 });
  });
});
