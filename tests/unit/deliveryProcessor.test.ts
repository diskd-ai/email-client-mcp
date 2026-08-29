import { describe, expect, it, vi } from "vitest";
import type {
  OutboxItem,
  OutboxRepository,
} from "../../src/delivery/application/outboxRepository.js";
import { encodeDeliveryProgress } from "../../src/delivery/domain/deliveryProgress.js";
import { buildDeliveryProcessor } from "../../src/delivery/infrastructure/deliveryProcessor.js";
import type { DriveAttachmentLoader } from "../../src/delivery/infrastructure/driveAttachmentLoader.js";
import type { SentFolderAppender } from "../../src/delivery/infrastructure/sentFolderAppender.js";
import type { SmtpSender } from "../../src/delivery/infrastructure/smtpTransport.js";
import { None, Ok, Some } from "../../src/domain/result.js";

const payload = {
  messageId: "review-1",
  account: "work",
  threadId: null,
  inReplyTo: null,
  from: { name: "Agent", address: "agent@example.com" },
  to: [{ name: "Lead", address: "lead@example.com" }],
  cc: [],
  bcc: [],
  subject: "Viewing request",
  bodyText: "Hello",
  bodyHtml: "",
  hasAttachments: false,
  attachments: [],
};

const availableItem: OutboxItem = {
  externalId: "review-1",
  account: "work",
  mailboxId: "exchange-work",
  state: "outbox",
  payload,
  result: None,
  revision: "2",
  deliveryAttempts: 0,
  lease: { kind: "Available" },
  failureReason: None,
  createdAt: "2026-08-29T12:00:00.000Z",
  updatedAt: "2026-08-29T12:00:00.000Z",
};

const makeRepository = (initialItem: OutboxItem, calls: string[]): OutboxRepository => ({
  get: vi.fn(async () => Ok(initialItem)),
  listPending: vi.fn(async () => Ok({ items: [], nextCursor: None })),
  claim: vi.fn(async () => {
    calls.push("claim");
    return Ok({
      ...initialItem,
      revision: "3",
      deliveryAttempts: initialItem.deliveryAttempts + 1,
      lease: {
        kind: "Leased" as const,
        owner: "email-client-mcp-test",
        expiresAt: "2026-08-29T12:03:00.000Z",
      },
    });
  }),
  renewLease: vi.fn(async () => Ok(initialItem)),
  writeProgress: vi.fn(async (input) => {
    calls.push(`progress:${input.progress.kind}`);
    return Ok({
      ...initialItem,
      revision: input.progress.kind === "DeliveryStarted" ? "4" : "5",
      deliveryAttempts: initialItem.deliveryAttempts + 1,
      lease: {
        kind: "Leased" as const,
        owner: "email-client-mcp-test",
        expiresAt: "2026-08-29T12:03:00.000Z",
      },
      result: Some(encodeDeliveryProgress(input.progress)),
    });
  }),
  writeTerminal: vi.fn(async (input) => {
    calls.push(`terminal:${input.outcome.kind}`);
    return Ok({
      ...initialItem,
      revision: "5",
      state: input.outcome.kind === "Sent" ? "sent" : "failed",
      lease: { kind: "Available" as const },
      failureReason: input.outcome.kind === "Failed" ? Some(input.outcome.reason) : None,
    });
  }),
});

const accountConfig = {
  name: "work",
  email: "agent@example.com",
  full_name: "Sales Agent",
  password: "secret",
  imap: { host: "imap.example.com", port: 993, tls: true, verify_ssl: true },
  smtp: {
    host: "smtp.example.com",
    port: 465,
    tls: true,
    starttls: false,
    verify_ssl: true,
  },
};

const makeProcessor = (
  repository: OutboxRepository,
  sender: SmtpSender,
  calls: string[],
  overrides: {
    readonly attachmentLoader?: DriveAttachmentLoader;
    readonly sentFolderAppender?: SentFolderAppender;
  } = {},
) =>
  buildDeliveryProcessor({
    repository,
    accounts: [{ config: accountConfig, sender }],
    rateLimiter: {
      waitForTurn: vi.fn(async () => {
        calls.push("rate");
      }),
    },
    leaseOwner: "email-client-mcp-test",
    now: () => new Date("2026-08-29T12:00:30.000Z"),
    log: vi.fn(),
    attachmentLoader: overrides.attachmentLoader ?? {
      load: vi.fn(async () => Ok([])),
    },
    sentFolderAppender: overrides.sentFolderAppender ?? {
      append: vi.fn(async () => {
        calls.push("imap-append");
        return Ok({ folder: "Sent", uidValidity: "42", uid: "101" });
      }),
    },
  });

describe("delivery/infrastructure/deliveryProcessor", () => {
  /* REQ-DELIVERY-039: Delivery intent is persisted before SMTP and Sent is written before ack. */
  it("marks delivery started before SMTP and records an accepted outcome", async () => {
    const calls: string[] = [];
    const repository = makeRepository(availableItem, calls);
    const sender: SmtpSender = {
      send: vi.fn(async () => {
        calls.push("smtp");
        return {
          kind: "Accepted",
          rawMessage: Buffer.from("RFC822 message"),
          receipt: {
            messageId: "<message@example.com>",
            accepted: ["lead@example.com"],
            rejected: [],
            response: "250 queued",
          },
        };
      }),
      close: vi.fn(),
    };

    const result = await makeProcessor(repository, sender, calls).process({
      kind: "Reconciliation",
      externalId: "review-1",
    });

    expect(result.kind).toBe("Ack");
    expect(calls).toEqual([
      "rate",
      "claim",
      "progress:DeliveryStarted",
      "smtp",
      "imap-append",
      "terminal:Sent",
    ]);
  });

  /* REQ-DELIVERY-040: A persisted delivery-start marker after restart never re-enters SMTP. */
  it("terminalizes a previously started delivery as FailedUnknown without resending", async () => {
    const calls: string[] = [];
    const startedItem: OutboxItem = {
      ...availableItem,
      result: Some(
        encodeDeliveryProgress({
          kind: "DeliveryStarted",
          messageId: "review-1",
          recordedAt: "2026-08-29T12:00:10.000Z",
        }),
      ),
    };
    const repository = makeRepository(startedItem, calls);
    const sender: SmtpSender = { send: vi.fn(), close: vi.fn() };

    const result = await makeProcessor(repository, sender, calls).process({
      kind: "Reconciliation",
      externalId: "review-1",
    });

    expect(result.kind).toBe("Ack");
    expect(sender.send).not.toHaveBeenCalled();
    expect(calls).toEqual(["claim", "terminal:Failed"]);
    expect(repository.writeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          kind: "Failed",
          reason: expect.stringContaining("FailedUnknown"),
        }),
      }),
    );
  });

  /* REQ-DELIVERY-041: Proven transient pre-acceptance failure is durably marked retry-safe. */
  it("marks a transient rejection retry-safe before asking JetStream to redeliver", async () => {
    const calls: string[] = [];
    const repository = makeRepository(availableItem, calls);
    const sender: SmtpSender = {
      send: vi.fn(async () => {
        calls.push("smtp");
        return {
          kind: "RejectedBeforeAcceptance",
          rejection: { kind: "Transient", failure: { reason: "connection refused" } },
        };
      }),
      close: vi.fn(),
    };

    const result = await makeProcessor(repository, sender, calls).process({
      kind: "Reconciliation",
      externalId: "review-1",
    });

    expect(result).toEqual({
      kind: "Retry",
      reason: "connection refused",
      delayMs: 185_000,
    });
    expect(calls).toEqual([
      "rate",
      "claim",
      "progress:DeliveryStarted",
      "smtp",
      "progress:RetrySafe",
    ]);
  });

  /* REQ-DELIVERY-042: Ambiguous SMTP outcomes are terminal and never retry-safe. */
  it("records an unknown SMTP outcome as terminal failure", async () => {
    const calls: string[] = [];
    const repository = makeRepository(availableItem, calls);
    const sender: SmtpSender = {
      send: vi.fn(async () => ({
        kind: "UnknownOutcome",
        failure: { reason: "response lost after DATA" },
      })),
      close: vi.fn(),
    };

    const result = await makeProcessor(repository, sender, calls).process({
      kind: "Reconciliation",
      externalId: "review-1",
    });

    expect(result.kind).toBe("Ack");
    expect(repository.writeProgress).toHaveBeenCalledTimes(1);
    expect(repository.writeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { kind: "Failed", reason: "FailedUnknown: response lost after DATA" },
      }),
    );
  });

  /* REQ-DELIVERY-054: Payload From must match the configured account identity before SMTP. */
  it("terminalizes an unauthorized From identity without calling SMTP", async () => {
    const calls: string[] = [];
    const repository = makeRepository(
      {
        ...availableItem,
        payload: {
          ...payload,
          from: { name: "Attacker", address: "attacker@example.com" },
        },
      },
      calls,
    );
    const sender: SmtpSender = { send: vi.fn(), close: vi.fn() };

    const result = await makeProcessor(repository, sender, calls).process({
      kind: "Reconciliation",
      externalId: "review-1",
    });

    expect(result.kind).toBe("Ack");
    expect(sender.send).not.toHaveBeenCalled();
    expect(calls).toEqual(["claim", "terminal:Failed"]);
    expect(repository.writeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          kind: "Failed",
          reason: expect.stringContaining("Invalid delivery identity"),
        }),
      }),
    );
  });

  /* REQ-DELIVERY-055: Drive attachment bytes are loaded before the persisted SMTP-start marker. */
  it("hydrates Drive attachments before starting SMTP delivery", async () => {
    const calls: string[] = [];
    const item: OutboxItem = {
      ...availableItem,
      payload: {
        ...payload,
        hasAttachments: true,
        attachments: [
          {
            path: "/Projects/acme/contract.pdf",
            filename: "contract.pdf",
            contentType: "application/pdf",
          },
        ],
      },
    };
    const repository = makeRepository(item, calls);
    const attachmentLoader: DriveAttachmentLoader = {
      load: vi.fn(async () => {
        calls.push("attachments");
        return Ok([
          {
            filename: "contract.pdf",
            contentType: "application/pdf",
            content: Buffer.from("pdf-bytes"),
          },
        ]);
      }),
    };
    const sender: SmtpSender = {
      send: vi.fn(async () => {
        calls.push("smtp");
        return {
          kind: "Accepted",
          rawMessage: Buffer.from("RFC822 message"),
          receipt: {
            messageId: "<message@example.com>",
            accepted: ["lead@example.com"],
            rejected: [],
            response: "250 queued",
          },
        };
      }),
      close: vi.fn(),
    };

    await makeProcessor(repository, sender, calls, { attachmentLoader }).process({
      kind: "Reconciliation",
      externalId: "review-1",
    });

    expect(calls).toEqual([
      "rate",
      "claim",
      "attachments",
      "progress:DeliveryStarted",
      "smtp",
      "imap-append",
      "terminal:Sent",
    ]);
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ filename: "contract.pdf" })],
      }),
    );
  });

  /* REQ-DELIVERY-056: Sent-folder append failure is observable but never resubmits accepted SMTP. */
  it("records Sent after an observable IMAP append failure", async () => {
    const calls: string[] = [];
    const repository = makeRepository(availableItem, calls);
    const sender: SmtpSender = {
      send: vi.fn(async () => {
        calls.push("smtp");
        return {
          kind: "Accepted",
          rawMessage: Buffer.from("RFC822 message"),
          receipt: {
            messageId: "<message@example.com>",
            accepted: ["lead@example.com"],
            rejected: [],
            response: "250 queued",
          },
        };
      }),
      close: vi.fn(),
    };
    const sentFolderAppender: SentFolderAppender = {
      append: vi.fn(async () => {
        calls.push("imap-append");
        return {
          tag: "Err",
          error: { kind: "SentFolderMissing", accountId: "work" },
        };
      }),
    };

    const result = await makeProcessor(repository, sender, calls, {
      sentFolderAppender,
    }).process({
      kind: "Reconciliation",
      externalId: "review-1",
    });

    expect(result.kind).toBe("Ack");
    expect(repository.writeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          kind: "Sent",
          providerResponse: expect.objectContaining({
            sentFolderAppend: expect.objectContaining({ status: "failed" }),
          }),
        }),
      }),
    );
  });
});
