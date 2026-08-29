import { describe, expect, it, vi } from "vitest";
import { buildSentFolderAppender } from "../../src/delivery/infrastructure/sentFolderAppender.js";
import { Ok } from "../../src/domain/result.js";

describe("delivery/infrastructure/sentFolderAppender", () => {
  /* REQ-DELIVERY-050: SMTP-accepted RFC822 bytes are appended to the provider's special-use Sent folder. */
  it("appends the exact message with the Seen flag", async () => {
    const append = vi.fn().mockResolvedValue({
      destination: "Sent Items",
      uidValidity: 42n,
      uid: 101,
    });
    const appender = buildSentFolderAppender({
      forAccount: vi.fn().mockResolvedValue(
        Ok({
          list: vi
            .fn()
            .mockResolvedValue([{ path: "INBOX" }, { path: "Sent Items", specialUse: "\\Sent" }]),
          append,
        }),
      ),
    });
    const rawMessage = Buffer.from("Message-ID: <stable@example.com>\r\n\r\nBody");

    const result = await appender.append("work", rawMessage, new Date("2026-08-29T12:00:30.000Z"));

    expect(result).toEqual({
      tag: "Ok",
      value: {
        folder: "Sent Items",
        uidValidity: "42",
        uid: "101",
      },
    });
    expect(append).toHaveBeenCalledWith(
      "Sent Items",
      rawMessage,
      ["\\Seen"],
      new Date("2026-08-29T12:00:30.000Z"),
    );
  });

  /* REQ-DELIVERY-051: A missing special-use Sent folder is surfaced explicitly. */
  it("surfaces a missing Sent folder", async () => {
    const appender = buildSentFolderAppender({
      forAccount: vi.fn().mockResolvedValue(
        Ok({
          list: vi.fn().mockResolvedValue([{ path: "INBOX" }]),
          append: vi.fn(),
        }),
      ),
    });

    const result = await appender.append("work", Buffer.from("message"), new Date());

    expect(result).toEqual({
      tag: "Err",
      error: { kind: "SentFolderMissing", accountId: "work" },
    });
  });
});
