import { describe, expect, it, vi } from "vitest";
import { buildDriveAttachmentLoader } from "../../src/delivery/infrastructure/driveAttachmentLoader.js";

const streamBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

describe("delivery/infrastructure/driveAttachmentLoader", () => {
  /* REQ-DELIVERY-048: Attachment bytes are hydrated through the canonical Drive path API. */
  it("downloads and bounds one referenced attachment", async () => {
    const file = vi.fn().mockResolvedValue({
      stream: streamBytes(new TextEncoder().encode("pdf-bytes")),
      size: 9,
      mimeType: "application/pdf",
    });
    const loader = buildDriveAttachmentLoader({ download: { file } });

    const result = await loader.load([
      {
        path: "/Projects/acme/contract.pdf",
        filename: "contract.pdf",
        contentType: "application/pdf",
      },
    ]);

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value[0]).toMatchObject({
        filename: "contract.pdf",
        contentType: "application/pdf",
      });
      expect(result.value[0]?.content.toString()).toBe("pdf-bytes");
    }
    expect(file).toHaveBeenCalledWith({ path: "/Projects/acme/contract.pdf" });
  });

  /* REQ-DELIVERY-049: Oversized attachment artifacts fail before SMTP submission. */
  it("rejects a download larger than the configured total", async () => {
    const loader = buildDriveAttachmentLoader(
      {
        download: {
          file: vi.fn().mockResolvedValue({
            stream: streamBytes(new Uint8Array()),
            size: 11,
            mimeType: "application/octet-stream",
          }),
        },
      },
      { maxTotalBytes: 10 },
    );

    const result = await loader.load([
      {
        path: "/Projects/acme/large.bin",
        filename: "large.bin",
        contentType: "application/octet-stream",
      },
    ]);

    expect(result).toEqual({
      tag: "Err",
      error: {
        kind: "AttachmentSizeExceeded",
        path: "/Projects/acme/large.bin",
        maxTotalBytes: 10,
      },
    });
  });
});
