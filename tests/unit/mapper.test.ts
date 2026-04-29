import { describe, expect, it } from "vitest";
import {
  type FetchedMessageLike,
  htmlToText,
  stripQuotedAndSignature,
  toStoredPayload,
} from "../../src/imap/mapper.js";

const fixedNow = new Date("2026-04-29T10:00:00.000Z");

const baseParams = {
  accountId: "work",
  mailbox: "INBOX",
  uidValidity: 999,
  fetchedAt: fixedNow,
  bodyText: "Hello world",
  bodyHtml: "<p>Hello world</p>",
  truncated: false,
};

describe("imap/mapper", () => {
  /* REQUIREMENT end:comm/email-client-mcp/imap/mapper -- envelope addresses become non-empty EmailAddress[] */
  it("maps envelope addresses", () => {
    const msg: FetchedMessageLike = {
      uid: 42,
      flags: new Set(["\\Seen"]),
      envelope: {
        date: new Date("2026-01-01T12:00:00Z"),
        subject: "Hi",
        messageId: "<a@b>",
        from: [{ name: "Alice", address: "alice@example.com" }],
        to: [{ address: "bob@example.com" }],
        cc: [],
      },
    };
    const payload = toStoredPayload(msg, baseParams);
    expect(payload.from).toEqual({ name: "Alice", address: "alice@example.com" });
    expect(payload.to).toEqual([{ name: null, address: "bob@example.com" }]);
    expect(payload.cc).toEqual([]);
    expect(payload.subject).toBe("Hi");
    expect(payload.messageId).toBe("<a@b>");
    expect(payload.flags).toEqual(["\\Seen"]);
    expect(payload.date).toBe("2026-01-01T12:00:00.000Z");
  });

  /* REQUIREMENT end:comm/email-client-mcp/imap/mapper -- attachments collected from bodyStructure (multipart walk) */
  it("walks bodyStructure and collects attachments", () => {
    const msg: FetchedMessageLike = {
      uid: 1,
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          { type: "text/plain", part: "1" },
          {
            type: "application/pdf",
            part: "2",
            disposition: "attachment",
            dispositionParameters: { filename: "report.pdf" },
            size: 1234,
          },
        ],
      },
    };
    const payload = toStoredPayload(msg, baseParams);
    expect(payload.hasAttachments).toBe(true);
    expect(payload.attachments).toEqual([
      { filename: "report.pdf", contentType: "application/pdf", sizeBytes: 1234, partId: "2" },
    ]);
  });

  /* REQUIREMENT end:comm/email-client-mcp/imap/mapper -- missing envelope yields empty defaults, not throws */
  it("tolerates missing envelope", () => {
    const msg: FetchedMessageLike = { uid: 7 };
    const payload = toStoredPayload(msg, baseParams);
    expect(payload.subject).toBe("");
    expect(payload.from).toBeNull();
    expect(payload.to).toEqual([]);
    expect(payload.date).toBe(fixedNow.toISOString());
  });

  /* REQUIREMENT end:comm/email-client-mcp/imap/mapper -- snippet built from text body */
  it("builds a snippet from the text body", () => {
    const msg: FetchedMessageLike = { uid: 1 };
    const payload = toStoredPayload(msg, { ...baseParams, bodyText: "one\ntwo\n  three   spaces" });
    expect(payload.snippet).toBe("one two three spaces");
  });

  /* REQUIREMENT end:comm/email-client-mcp/imap/mapper -- htmlToText strips tags and decodes basic entities */
  it("htmlToText strips tags and decodes entities", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>world</b>!</p>")).toBe("Hello world !");
    expect(htmlToText("<script>bad()</script><p>safe</p>")).toBe("safe");
  });

  /* REQUIREMENT end:comm/email-client-mcp/imap/mapper -- stripQuotedAndSignature drops reply blocks and signatures */
  it("stripQuotedAndSignature drops quoted reply and signature", () => {
    const input = ["Hi there.", "", "On Mon, 1 Apr 2026, Bob wrote:", "> earlier", "> stuff"].join(
      "\n",
    );
    expect(stripQuotedAndSignature(input)).toBe("Hi there.");
    const sig = ["Thanks", "-- ", "Alice", "CEO"].join("\n");
    expect(stripQuotedAndSignature(sig)).toBe("Thanks");
  });
});
