import { describe, expect, it } from "vitest";
import { parseEmailOutboxPayload } from "../../src/delivery/infrastructure/emailOutboxPayload.js";

const payload = {
  messageId: "review-1",
  account: "work",
  threadId: null,
  inReplyTo: null,
  from: { name: "Agent", address: "agent@example.com" },
  to: [{ name: "Lead", address: "lead@example.com" }],
  cc: [],
  bcc: [{ name: "Audit", address: "audit@example.com" }],
  subject: "Viewing request",
  bodyText: "Hello",
  bodyHtml: "",
  hasAttachments: false,
  attachments: [],
  folderId: "review",
};

describe("delivery/infrastructure/emailOutboxPayload", () => {
  /* REQ-DELIVERY-028: The delivery boundary validates and retains every email recipient. */
  it("parses the shared outbound email contract and ignores Review projection fields", () => {
    const result = parseEmailOutboxPayload(payload, "work");

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.bcc).toEqual([{ name: "Audit", address: "audit@example.com" }]);
      expect(result.value).not.toHaveProperty("folderId");
    }
  });

  /* REQ-DELIVERY-029: Stored account identity and payload account identity must agree. */
  it("rejects an account mismatch", () => {
    const result = parseEmailOutboxPayload(payload, "personal");

    expect(result).toEqual({
      tag: "Err",
      error: {
        kind: "InvalidEmailOutboxPayload",
        issues: ["account: payload account does not match the stored Outbox account"],
      },
    });
  });

  /* REQ-DELIVERY-030: The attachment-free contract rejects payloads that could silently drop files. */
  it("rejects attachments", () => {
    const result = parseEmailOutboxPayload(
      { ...payload, hasAttachments: true, attachments: [{ name: "contract.pdf" }] },
      "work",
    );

    expect(result.tag).toBe("Err");
  });
});
