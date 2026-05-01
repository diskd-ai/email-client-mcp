import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDriveStore } from "../../src/store/driveStore.js";

const chunks = async function* (): AsyncIterable<Uint8Array> {
  yield Buffer.from("hello");
  yield Buffer.from("-");
  yield Buffer.from("world");
};

const buildStore = (options?: {
  readonly commitConflict?: boolean;
  readonly listedSize?: number;
}) => {
  const attachments = {
    uploadStart: vi.fn(async () => ({ intentId: "intent-1", uploadUrl: "/api/v1/drive/upload" })),
    uploadCommit: vi.fn(async () => {
      if (options?.commitConflict) throw new Error("JSON-RPC error: CONFLICT");
      return { attachmentId: "14:94:2", driveInode: "inode-new", sizeBytes: 11 };
    }),
    list: vi.fn(async () => [
      {
        attachmentId: "14:94:2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: options?.listedSize ?? 11,
        driveInode: "inode-existing",
        createdAt: "2026-04-29T10:00:00.000Z",
      },
    ]),
  };
  const store = {
    mailbox: vi.fn(() => ({
      folder: vi.fn(() => ({
        message: vi.fn(() => ({ attachments })),
      })),
    })),
  };
  return { store, attachments };
};

const originalFetch = globalThis.fetch;

const stubFetch = (fn: typeof fetch): void => {
  globalThis.fetch = fn;
};

describe("store/buildDriveStore attachment upload", () => {
  beforeEach(() => {
    process.env.APIS_BASE_URL = "https://app.example.test";
    process.env.APIS_API_KEY = "api-key";
    process.env.APIS_WORKSPACE_ID = "workspace-1";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("streams PUT bytes with upload intent headers and commits the attachment", async () => {
    const { store, attachments } = buildStore();
    const consumed: string[] = [];
    stubFetch(
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        for await (const chunk of init?.body as AsyncIterable<Uint8Array>) {
          consumed.push(Buffer.from(chunk).toString("utf8"));
        }
        return new Response(JSON.stringify({ etag: "etag-1" }), { status: 200 });
      }) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.uploadAttachment(
      "mail-w1",
      "INBOX",
      "14:94",
      {
        attachmentId: "14:94:2",
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 11,
      },
      chunks(),
    );

    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value).toMatchObject({
        attachmentId: "14:94:2",
        driveInode: "inode-new",
        storedSizeBytes: 11,
      });
    }
    expect(consumed).toEqual(["hello", "-", "world"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://app.example.test/v1/os/drive/api/v1/drive/upload",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "X-Api-Key": "api-key",
          "X-Workspace-Id": "workspace-1",
          "X-Upload-Intent-Id": "intent-1",
          "Content-Length": "11",
          "Content-Type": "application/pdf",
        }),
        duplex: "half",
      }),
    );
    expect(attachments.uploadCommit).toHaveBeenCalledWith({
      attachmentId: "14:94:2",
      intentId: "intent-1",
      etag: "etag-1",
      autoCommit: false,
    });
  });

  it("treats duplicate attachment commit as idempotent only when metadata matches", async () => {
    const { store, attachments } = buildStore({ commitConflict: true });
    stubFetch(
      vi.fn(
        async () => new Response(JSON.stringify({ etag: "etag-1" }), { status: 200 }),
      ) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.uploadAttachment(
      "mail-w1",
      "INBOX",
      "14:94",
      {
        attachmentId: "14:94:2",
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 11,
      },
      chunks(),
    );

    expect(result.tag).toBe("Ok");
    expect(attachments.list).toHaveBeenCalledTimes(1);
    if (result.tag === "Ok") {
      expect(result.value.driveInode).toBe("inode-existing");
      expect(result.value.storedAt).toBe("2026-04-29T10:00:00.000Z");
    }
  });

  it("fails duplicate attachment commit when existing metadata differs", async () => {
    const { store } = buildStore({ commitConflict: true, listedSize: 12 });
    stubFetch(
      vi.fn(
        async () => new Response(JSON.stringify({ etag: "etag-1" }), { status: 200 }),
      ) as typeof fetch,
    );

    const drive = buildDriveStore(store as never);
    const result = await drive.uploadAttachment(
      "mail-w1",
      "INBOX",
      "14:94",
      {
        attachmentId: "14:94:2",
        partId: "2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 11,
      },
      chunks(),
    );

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error.message).toContain("mismatched metadata");
    }
  });
});
