import { describe, expect, it } from "vitest";
import { findDisplayBodyPartIds } from "../../src/imap/fetch.js";

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
