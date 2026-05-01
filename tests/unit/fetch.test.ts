import { describe, expect, it } from "vitest";
import { decodeMimeBodyPart, findDisplayBodyPartIds } from "../../src/imap/fetch.js";

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
