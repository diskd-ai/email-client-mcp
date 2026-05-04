import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { isRetryableImapError } from "../../src/domain/errors.js";
import {
  decodeMimeBodyPart,
  downloadPartByUid,
  fetchDisplayBodyByUid,
  fetchMetadataUidRange,
  findDisplayBodyPartIds,
} from "../../src/imap/fetch.js";

describe("imap/fetch metadata-only range", () => {
  /* REQUIREMENT end:comm/email-client-mcp/imap/fetch -- metadata sync fetches envelope/bodyStructure without display body parts */
  it("fetches message metadata without requesting body parts", async () => {
    const fetchCalls: unknown[] = [];
    const client = {
      fetch: async function* (...args: unknown[]) {
        fetchCalls.push(args);
        yield {
          uid: 7,
          flags: new Set(["\\Seen"]),
          envelope: { subject: "Indexed" },
          bodyStructure: { type: "multipart/mixed" },
          internalDate: new Date("2026-04-29T10:00:00.000Z"),
        };
      },
      fetchOne: async () => {
        throw new Error("metadata range must not fetch body parts");
      },
      download: async () => {
        throw new Error("metadata range must not download attachments");
      },
    };

    const messages = [];
    for await (const msg of fetchMetadataUidRange(client as never, 5, 9)) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]?.uid).toBe(7);
    expect(fetchCalls).toEqual([
      [
        "5:9",
        {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          internalDate: true,
        },
        { uid: true },
      ],
    ]);
  });
});

describe("imap/fetch display body hydration", () => {
  /* REQUIREMENT end:comm/email-client-mcp/imap/fetch -- body hydration fetches display parts without downloading attachments */
  it("fetches display body parts by UID and never calls attachment download", async () => {
    const fetchOneCalls: unknown[] = [];
    const client = {
      fetchOne: async (...args: unknown[]) => {
        fetchOneCalls.push(args);
        if (fetchOneCalls.length === 1) {
          return {
            uid: 42,
            bodyStructure: {
              type: "multipart/mixed",
              childNodes: [
                {
                  part: "1",
                  type: "text/plain",
                  encoding: "7bit",
                  parameters: { charset: "utf-8" },
                },
                {
                  part: "2",
                  type: "application/pdf",
                  disposition: "attachment",
                  dispositionParameters: { filename: "report.pdf" },
                },
              ],
            },
          };
        }
        return {
          uid: 42,
          bodyParts: new Map([["1", Buffer.from("Hello body", "utf8")]]),
        };
      },
      download: async () => {
        throw new Error("body hydration must not download attachments");
      },
    };

    const body = await fetchDisplayBodyByUid(client as never, 42);

    expect(body).toEqual({
      bodyText: "Hello body",
      bodyHtml: null,
      truncated: false,
      bytesRead: 10,
    });
    expect(fetchOneCalls).toEqual([
      [
        "42",
        { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true },
        { uid: true },
      ],
      ["42", { uid: true, bodyParts: ["1"] }, { uid: true }],
    ]);
  });
});

describe("imap/fetch attachment download", () => {
  /* REQUIREMENT end:comm/email-client-mcp/imap/fetch -- attachment stream errors are captured before consumers start reading */
  it("captures upload stream errors emitted before consumption and releases the mailbox lock", async () => {
    let released = 0;
    let downloadCalls = 0;
    const uploadStream = new Readable({ read() {} });
    const client = {
      getMailboxLock: async () => ({
        release: () => {
          released += 1;
        },
      }),
      download: async () => {
        downloadCalls += 1;
        if (downloadCalls === 1) {
          return {
            content: Readable.from([Buffer.from("probe")]),
            meta: { contentType: "application/pdf" },
          };
        }
        return { content: uploadStream, meta: { contentType: "application/pdf" } };
      },
    };

    const downloaded = await downloadPartByUid(client as never, "INBOX", 42, "2");
    const streamError = new Error("Some messages could not be FETCHed (Failure) [THROTTLED]");

    expect(() => uploadStream.emit("error", streamError)).not.toThrow();
    await expect(
      (async () => {
        for await (const _chunk of downloaded.content) {
          // consume
        }
      })(),
    ).rejects.toThrow(/THROTTLED/);

    expect(released).toBe(2);
    expect(isRetryableImapError(streamError)).toBe(true);
  });

  it("releases the mailbox lock when the probe stream fails", async () => {
    let released = 0;
    const client = {
      getMailboxLock: async () => ({
        release: () => {
          released += 1;
        },
      }),
      download: async () => ({
        content: Readable.from(
          (async function* () {
            yield Buffer.from("partial");
            throw new Error("probe failed");
          })(),
        ),
        meta: { contentType: "application/pdf" },
      }),
    };

    await expect(downloadPartByUid(client as never, "INBOX", 42, "2")).rejects.toThrow(
      /probe failed/,
    );
    expect(released).toBe(1);
  });
});

describe("imap/fetch body part discovery", () => {
  /* REQUIREMENT end:comm/email-client-mcp/imap/fetch -- display body fetch uses concrete MIME part ids, never semantic BODY.PEEK[HTML] */
  it("finds text/plain and text/html leaves in a multipart message", () => {
    const bodyStructure = {
      type: "multipart/mixed",
      childNodes: [
        {
          part: "1",
          type: "multipart/alternative",
          childNodes: [
            { part: "1.1", type: "text/plain" },
            { part: "1.2", type: "text/html" },
          ],
        },
        {
          part: "2",
          type: "application/pdf",
          disposition: "attachment",
          dispositionParameters: { filename: "PORTES.pdf" },
        },
      ],
    };

    expect(findDisplayBodyPartIds(bodyStructure)).toEqual({
      textPartId: "1.1",
      htmlPartId: "1.2",
    });
  });

  it("skips inline filename parts when choosing display body parts", () => {
    const bodyStructure = {
      type: "multipart/related",
      childNodes: [
        { part: "1", type: "text/html" },
        {
          part: "2",
          type: "image/png",
          disposition: "inline",
          parameters: { name: "logo.png" },
        },
      ],
    };

    expect(findDisplayBodyPartIds(bodyStructure)).toEqual({
      textPartId: null,
      htmlPartId: "1",
    });
  });

  it("falls back to part 1 for single-part text messages", () => {
    expect(findDisplayBodyPartIds({ type: "text/plain" })).toEqual({
      textPartId: "1",
      htmlPartId: null,
    });
  });
});

describe("imap/fetch MIME body decoding", () => {
  /* REQUIREMENT end:comm/email-client-mcp/imap/fetch -- base64 display body parts are decoded before storage */
  it("decodes base64 html body parts", () => {
    const encoded = Buffer.from("PGh0bWw+PGJvZHk+0J/RgNC40LLQtdGCPC9ib2R5PjwvaHRtbD4=", "ascii");

    expect(
      decodeMimeBodyPart(encoded, {
        transferEncoding: "base64",
        charset: "utf-8",
      }),
    ).toBe("<html><body>Привет</body></html>");
  });

  /* REQUIREMENT end:comm/email-client-mcp/imap/fetch -- quoted-printable display body parts are decoded before storage */
  it("decodes quoted-printable utf-8 body parts including soft line breaks", () => {
    const encoded = Buffer.from("Bonjour =C3=A0 tous=2E=\r\n Suite", "ascii");

    expect(
      decodeMimeBodyPart(encoded, {
        transferEncoding: "quoted-printable",
        charset: "utf-8",
      }),
    ).toBe("Bonjour à tous. Suite");
  });

  it("uses the MIME charset when decoding transfer-decoded bytes", () => {
    const encoded = Buffer.from("z/Do4uXy", "ascii");

    expect(
      decodeMimeBodyPart(encoded, {
        transferEncoding: "base64",
        charset: "windows-1251",
      }),
    ).toBe("Привет");
  });

  it("keeps unencoded utf-8 body parts readable", () => {
    expect(
      decodeMimeBodyPart(Buffer.from("Plain text Привет", "utf8"), {
        transferEncoding: "7bit",
        charset: "utf-8",
      }),
    ).toBe("Plain text Привет");
  });
});
